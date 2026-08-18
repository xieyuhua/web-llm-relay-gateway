package ws

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"gateway/internal/task"

	"github.com/gorilla/websocket"
)

// Hub 管理所有插件实例连接与任务路由。
type Hub struct {
	mu       sync.RWMutex
	clients  map[string]*Client // instanceID -> client
	byTag    map[string][]*Client
	rr       map[string]int     // tag -> 轮询游标
	taskMgr  *task.Manager
	upgrader websocket.Upgrader
	wsToken  string // 插件注册所需的 Access Token（与 /v1 的 auth_token 一致）
	debug    bool   // debug 模式：打印客户端连接信息与会话收发原文
	maxQueue int    // 每个实例允许排队的最大请求数（不含正在执行的 1 个）
}

// NewHub 创建 Hub。wsToken 为插件 WebSocket 注册校验令牌，空字符串表示不校验（不推荐）。
// debug 为 true 时打印客户端连接信息与会话收发原文（含 token 脱敏）。
// maxQueue 为每个实例允许排队等待的最大请求数（不含正在执行的 1 个）。
func NewHub(taskMgr *task.Manager, wsToken string, debug bool, maxQueue int) *Hub {
	return &Hub{
		clients: make(map[string]*Client),
		byTag:   make(map[string][]*Client),
		rr:      make(map[string]int),
		taskMgr: taskMgr,
		wsToken: wsToken,
		debug:   debug,
		maxQueue: maxQueue,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// ErrBusy 表示实例排队已满，拒绝新请求（HTTP 侧返回 503 系统繁忙）。
var ErrBusy = errors.New("instance busy: queue full")

// debugf 仅在 debug 模式打印。
func (h *Hub) debugf(format string, args ...interface{}) {
	if h.debug {
		log.Printf("[debug] "+format, args...)
	}
}

// register 注册实例。
// 同一个 instance_id 重复注册时，先清掉旧条目（避免重连风暴下 byTag 列表无限膨胀）。
func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// 清理该 instance_id 在 byTag 中的旧引用
	if old, ok := h.clients[c.InstanceID]; ok && old != c {
		if tagged := h.byTag[old.Tag]; len(tagged) > 0 {
			out := tagged[:0]
			for _, x := range tagged {
				if x.InstanceID != c.InstanceID {
					out = append(out, x)
				}
			}
			h.byTag[old.Tag] = out
		}
	}
	h.clients[c.InstanceID] = c
	h.byTag[c.Tag] = append(h.byTag[c.Tag], c)
}

// unregister 注销实例，并标记其关联任务失败。
func (h *Hub) unregister(instanceID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.clients[instanceID]
	if !ok {
		return
	}
	delete(h.clients, instanceID)
	// 从 tag 列表移除
	tagged := h.byTag[c.Tag]
	out := tagged[:0]
	for _, x := range tagged {
		if x.InstanceID != instanceID {
			out = append(out, x)
		}
	}
	h.byTag[c.Tag] = out
	h.taskMgr.OnInstanceGone(instanceID)
	log.Printf("[hub] instance %s unregistered", instanceID)
}

// RouteTo 按 model 路由（对外公开版本，内部加锁）。
//   - 若 model 直接匹配某个在线实例的 instance_id，则精确路由到该实例（按实例精确选择）。
//   - 否则 model 前缀匹配 tag（如 chatgpt-web -> chatgpt），在 tag 下所有在线实例中
//     选择「并发任务数最少」的实例；若并发相同则按轮询游标打散（负载均衡）。
//   - 无匹配 tag 时（如 auto），在所有在线实例中择优。
//
// 返回在线实例；无可用实例返回 nil。
func (h *Hub) RouteTo(model string) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.routeToLocked(model)
}

// routeToLocked 按 model 路由（调用方需持有 h.mu）。
func (h *Hub) routeToLocked(model string) *Client {
	tag := h.modelTag(model)

	pick := func(list []*Client) *Client {
		var best *Client
		bestLoad := int(^uint(0) >> 1) // 最大 int
		for _, c := range list {
			if !c.Online {
				continue
			}
			load := c.getTasks()
			if load < bestLoad {
				bestLoad = load
				best = c
			}
		}
		if best == nil {
			return nil
		}
		// 轮询打散：同负载时移动游标
		h.rr[tag] = (h.rr[tag] + 1) % (len(list) + 1)
		return best
	}

	if candidates := h.byTag[tag]; len(candidates) > 0 {
		if c := pick(candidates); c != nil {
			return c
		}
	}
	// auto / 无匹配：从所有在线实例择优
	all := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		all = append(all, c)
	}
	return pick(all)
}

// Dispatch 路由到实例并增加其并发计数，返回所选实例（nil 表示无可用）。
// 注意：当前已改为基于实例内串行队列（见 Enqueue），Dispatch 仅做路由选择，
// 不再直接递增并发计数；保留以便兼容旧调用点。
func (h *Hub) Dispatch(model, taskID string) *Client {
	return h.RouteTo(model)
}

// Enqueue 将任务排入目标实例的串行执行队列。
// 语义：每个 WS 实例同一时刻只允许 1 个客户端在网页上操作；其余请求进入该实例
// 的等待队列（容量 = maxQueue）。队列已满则直接返回 ErrBusy，由 HTTP 层返回 503 系统繁忙。
//
// 入队成功后立即返回（task.create 由实例的 serve 协程按 FIFO 顺序真正下发），
// 调用方（HTTP handler）随即开始阻塞读取任务的 SSE 流，等前面任务跑完即被调度。
func (h *Hub) Enqueue(model, taskID string, task *task.Task, taskData *Envelope) (*Client, error) {
	h.mu.RLock()
	c := h.routeToLocked(model)
	h.mu.RUnlock()
	if c == nil {
		return nil, errors.New("no available instance for model " + model)
	}
	// 容量检查：队列中已等待的数量 + 正在执行的 1 个 ≤ maxQueue + 1
	if len(c.queue) >= h.maxQueue {
		return nil, ErrBusy
	}
	c.queue <- &pendingTask{taskID: taskID, task: task, env: taskData}
	return c, nil
}

// Release 任务结束时的清理钩子（当前串行队列下为兼容保留，无实际操作）。
func (h *Hub) Release(instanceID string) {
	// 串行队列由 serve 协程自行调度，无需在此递减计数。
}

// SendTo 向指定实例下发消息（如 task.cancel）。
func (h *Hub) SendTo(instanceID string, env *Envelope) {
	h.mu.RLock()
	c, ok := h.clients[instanceID]
	h.mu.RUnlock()
	if ok && c.Online {
		_ = c.Send(env)
	}
}

// modelTag 解析请求 model 对应的路由 tag。
// 优先级：
//  1. 若 model 本身就是一个在线实例的 tag（如 "chatgpt-web-3"），原样返回，不做任何截断；
//  2. 否则取 model 首段作为 tag（chatgpt-4o -> chatgpt），兼容 "model-tag" 风格；
//  3. 仍无匹配则返回原 model（交给上层按 instance_id / 配置 model 处理）。
//
// 关键：绝不能把 "chatgpt-web-3" 这类含 "-" 的完整 tag 截断成 "chatgpt"，
// 否则与实例上报的 tag 对不上，导致路由失败（unsupported model）。
func (h *Hub) modelTag(model string) string {
	h.mu.RLock()
	_, exact := h.byTag[model]
	h.mu.RUnlock()
	if exact {
		return model
	}
	for i := 0; i < len(model); i++ {
		if model[i] == '-' {
			return model[:i]
		}
	}
	return model
}

// Count 在线实例数（用于健康检查展示）。
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, c := range h.clients {
		if c.Online {
			n++
		}
	}
	return n
}

// OnlineTags 返回当前在线实例去重后的 tag 列表（即插件实例上报的 Instance Tag）。
// 模型名称以此为准：有插件连接时，下拉框展示的就是各实例的 tag。
func (h *Hub) OnlineTags() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := make(map[string]bool)
	tags := make([]string, 0)
	for _, c := range h.clients {
		if !c.Online {
			continue
		}
		if c.Tag != "" && !seen[c.Tag] {
			seen[c.Tag] = true
			tags = append(tags, c.Tag)
		}
	}
	return tags
}

// InstanceInfo 在线实例的简单描述（供模型列表/健康检查展示）。
type InstanceInfo struct {
	InstanceID string `json:"instance_id"`
	Tag        string `json:"tag"`
	Models     string `json:"models"`
	Online     bool   `json:"online"`
	Tasks      int    `json:"tasks"`
}

// OnlineClients 返回每个在线实例的明细（per-instance，不去重）。
// 用于「按实例精确选择」：模型下拉框列出每个实例（ID=instance_id），
// 调用方传入 instance_id 即可精确路由到该标签页。
func (h *Hub) OnlineClients() []InstanceInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]InstanceInfo, 0, len(h.clients))
	for _, c := range h.clients {
		if !c.Online {
			continue
		}
		out = append(out, InstanceInfo{
			InstanceID: c.InstanceID,
			Tag:        c.Tag,
			Models:     strings.Join(c.Models, ","),
			Online:     true,
			Tasks:      c.getTasks(),
		})
	}
	return out
}

// UpgradeAndServe 处理 WS 连接升级并启动读写循环。
// 从 query 参数自动注册实例（instance_id / tag / models），无需等待 register 消息。
// 注册前强制校验 Access Token（?token=），与 /v1 的 Bearer auth_token 一致，
// 防止非法/伪造实例注册到网关（未配置 token 的插件不会出现在 /models、/healthz）。
func (h *Hub) UpgradeAndServe(conn *websocket.Conn, r *http.Request) {
	// Token 校验：未携带或错误一律拒绝（注意 conn 已升级，需先写响应再关闭）。
	if h.wsToken != "" {
		q := r.URL.Query()
		if q.Get("token") != h.wsToken {
			log.Printf("[hub] WS register rejected: bad/missing token from %s", r.RemoteAddr)
			_ = conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "unauthorized: invalid or missing token"))
			_ = conn.Close()
			return
		}
	}
	c := NewClient(conn, h)
	q := r.URL.Query()
	if id := q.Get("instance_id"); id != "" {
		c.InstanceID = id
	}
	if tag := q.Get("tag"); tag != "" {
		c.Tag = tag
	}
	if models := q.Get("models"); models != "" {
		c.Models = splitComma(models)
	}
	// 连接信息日志（出于安全，不打印 token 与 UA）
	log.Printf("[ws] client connected from=%s instance_id=%s tag=%s models=%v", r.RemoteAddr, c.InstanceID, c.Tag, c.Models)
	h.debugf("WS handshake query: instance_id=%s tag=%s models=%s remote=%s",
		c.InstanceID, c.Tag, strings.Join(c.Models, ","), r.RemoteAddr)
	if c.InstanceID != "" {
		c.Online = true
		c.LastPing = time.Now().Unix()
		h.register(c)
		log.Printf("[hub] instance auto-registered: id=%s tag=%s models=%v", c.InstanceID, c.Tag, c.Models)
	} else {
		log.Printf("[hub] WS connected but no instance_id provided, not registered (addr=%s)", r.RemoteAddr)
	}
	go c.readLoop()
	go c.writeLoop()
}

func splitComma(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
		} else {
			cur += string(r)
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
