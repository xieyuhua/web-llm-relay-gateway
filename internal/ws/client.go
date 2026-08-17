package ws

import (
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Client 封装单个插件实例的 WebSocket 连接。
type Client struct {
	mu          sync.Mutex
	conn        *websocket.Conn
	InstanceID  string
	Tag         string
	Models      []string
	Online      bool
	LastPing    int64
	activeTasks int // 当前进行中任务数（用于负载均衡择优）
	hub         *Hub
	sendCh      chan []byte
	closeCh     chan struct{}
}

// NewClient 创建客户端。
func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		conn:    conn,
		Online:  true,
		sendCh:  make(chan []byte, 64),
		closeCh: make(chan struct{}),
		hub:     hub,
	}
}

// Send 下行发送（线程安全）。
func (c *Client) Send(envelope *Envelope) error {
	b, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, b)
}

// incrTasks / decrTasks 调整并发任务计数（负载均衡用）。
func (c *Client) incrTasks() {
	c.mu.Lock()
	c.activeTasks++
	c.mu.Unlock()
}

func (c *Client) decrTasks() {
	c.mu.Lock()
	if c.activeTasks > 0 {
		c.activeTasks--
	}
	c.mu.Unlock()
}

func (c *Client) getTasks() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.activeTasks
}

// readLoop 读取插件上行消息。
func (c *Client) readLoop() {
	defer c.close()
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			// 1005/1006 多为 service worker 被系统回收等「无状态关闭」，属正常重连场景，
			// 用 debug 级打印避免刷屏；其余异常仍按 info 打印。
			if c.hub.debug || (err != websocket.ErrCloseSent && !isAbnormalClose(err)) {
				log.Printf("[ws] instance %s read err: %v", c.InstanceID, err)
			} else {
				c.hub.debugf("instance %s read closed (abnormal/aborted): %v", c.InstanceID, err)
			}
			return
		}
		c.hub.debugf("RECV <- instance=%s\n%s", c.InstanceID, formatEnvelope(msg))
		c.handleMessage(msg)
	}
}

// isAbnormalClose 判断是否为「无状态关闭」（1005/1006），这类在 service worker 回收时常见，
// 不应作为错误刷屏。
func isAbnormalClose(err error) bool {
	if ce, ok := err.(*websocket.CloseError); ok {
		return ce.Code == 1005 || ce.Code == 1006
	}
	return false
}

// writeLoop 发送下行消息。
func (c *Client) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case b := <-c.sendCh:
			c.hub.debugf("SEND -> instance=%s\n%s", c.InstanceID, formatEnvelope(b))
			c.mu.Lock()
			err := c.conn.WriteMessage(websocket.TextMessage, b)
			c.mu.Unlock()
			if err != nil {
				log.Printf("[ws] instance %s write err: %v", c.InstanceID, err)
				return
			}
		case <-ticker.C:
			c.mu.Lock()
			err := c.conn.WriteMessage(websocket.TextMessage, mustJSON(&Envelope{Type: TypePing, Data: mustJSON(PingData{Ts: time.Now().Unix()})}))
			c.mu.Unlock()
			if err != nil {
				return
			}
		case <-c.closeCh:
			return
		}
	}
}

func (c *Client) handleMessage(raw []byte) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		log.Printf("[ws] bad envelope: %v", err)
		return
	}
	switch env.Type {
	case TypeRegister:
		var r RegisterData
		_ = json.Unmarshal(env.Data, &r)
		c.InstanceID = r.InstanceID
		c.Tag = r.Tag
		c.Models = r.Models
		c.Online = true
		c.LastPing = time.Now().Unix()
		c.hub.register(c)
		_ = c.Send(&Envelope{Type: TypeRegisterAck, Data: mustJSON(map[string]string{"instance_id": c.InstanceID})})
		log.Printf("[ws] instance registered: id=%s tag=%s models=%v", c.InstanceID, c.Tag, c.Models)
	case TypeTaskAck:
		c.hub.taskMgr.OnAck(env.TaskID)
	case TypeTaskDelta:
		var d DeltaData
		_ = json.Unmarshal(env.Data, &d)
		c.hub.taskMgr.OnDelta(env.TaskID, d.Payload)
	case TypeTaskDone:
		var d DoneData
		_ = json.Unmarshal(env.Data, &d)
		log.Printf("[relay] done  task=%s finish_reason=%s", env.TaskID, d.FinishReason)
		c.hub.taskMgr.OnDone(env.TaskID, d.FinishReason)
	case TypeTaskError:
		var d ErrorData
		_ = json.Unmarshal(env.Data, &d)
		log.Printf("[relay] error task=%s code=%s message=%s", env.TaskID, d.Code, d.Message)
		c.hub.taskMgr.Fail(env.TaskID, d.Code, d.Message)
	case TypePong:
		c.LastPing = time.Now().Unix()
	}
}

func (c *Client) close() {
	c.mu.Lock()
	if !c.Online {
		c.mu.Unlock()
		return
	}
	c.Online = false
	_ = c.conn.Close()
	close(c.closeCh)
	c.mu.Unlock()
	c.hub.unregister(c.InstanceID)
}

// truncate 截断过长字符串，便于日志打印
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}

func mustJSON(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// formatEnvelope 将 WS 报文格式化为可读的多行文本（debug 模式用）。长字段自动截断。
func formatEnvelope(raw []byte) string {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		// 非信封格式（异常）直接打印原文（截断），避免刷屏大报文
		return "  (raw) " + truncate(string(raw), 500)
	}
	var b strings.Builder
	typeLabel := env.Type
	if env.TaskID != "" {
		typeLabel += " task_id=" + env.TaskID
	}
	b.WriteString("  ┌─ " + typeLabel + "\n")
	switch env.Type {
	case TypeTaskCreate:
		var d TaskCreateData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ model    : " + d.Model + "\n")
			b.WriteString("  │ stream   : " + bool2s(d.Stream) + "\n")
			b.WriteString("  │ selector : " + d.Selector + "\n")
			b.WriteString("  │ send_btn : " + d.SendButton + "\n")
			b.WriteString("  │ answer   : " + d.AnswerSelector + "\n")
			b.WriteString("  │ messages :\n")
			for i, m := range d.Messages {
				b.WriteString("  │   [" + strconv.Itoa(i) + "] " + m.Role + ": " + truncate(m.Content, 300) + "\n")
			}
		}
	case TypeTaskDelta:
		var d DeltaData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ format   : " + d.Format + "\n")
			b.WriteString("  │ payload  : " + truncate(d.Payload, 400) + "\n")
		}
	case TypeTaskDone:
		var d DoneData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ finish_reason: " + d.FinishReason + "\n")
		}
	case TypeTaskError:
		var d ErrorData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ code    : " + d.Code + "\n")
			b.WriteString("  │ message : " + d.Message + "\n")
		}
	case TypeRegister:
		var d RegisterData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ instance_id: " + d.InstanceID + "\n")
			b.WriteString("  │ tag         : " + d.Tag + "\n")
			b.WriteString("  │ models      : " + strings.Join(d.Models, ", ") + "\n")
		}
	case TypePing, TypePong:
		var d PingData
		if json.Unmarshal(env.Data, &d) == nil {
			b.WriteString("  │ ts: " + strconv.FormatInt(d.Ts, 10) + "\n")
		}
	default:
		// 其他类型原样打印 data（缩进、截断）
		if len(env.Data) > 0 {
			b.WriteString("  │ data: " + truncate(string(env.Data), 500) + "\n")
		}
	}
	b.WriteString("  └─")
	return b.String()
}

func bool2s(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
