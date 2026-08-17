package httphandler

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"gateway/internal/config"
	"gateway/internal/openai"
	"gateway/internal/task"
	"gateway/internal/ws"
	"gateway/web"
)

// Handler 持有依赖。
type Handler struct {
	cfg     *config.Config
	hub     *ws.Hub
	taskMgr *task.Manager
}

// New 构造 Handler。
func New(cfg *config.Config, hub *ws.Hub, tm *task.Manager) *Handler {
	return &Handler{cfg: cfg, hub: hub, taskMgr: tm}
}

// Register 注册所有路由。
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", h.cors(h.Health))
	mux.HandleFunc(h.cfg.APIPrefix+"/models", h.cors(h.auth(h.Models)))
	mux.HandleFunc(h.cfg.APIPrefix+"/chat/completions", h.cors(h.auth(h.ChatCompletions)))
	mux.HandleFunc(h.cfg.APIPrefix+"/chat/cancel", h.cors(h.auth(h.CancelTask)))

	// 内置测试网页（用于快速验证对接是否成功）
	// web 资源已通过 embed 打包进二进制（见 internal/web），不再依赖进程工作目录
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		data, err := web.FS.ReadFile("test.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(data)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			data, err := web.FS.ReadFile("test.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(data)
			return
		}
		// 其余路径从 embed 的 web 目录提供（用于 test.html 可能引用的静态资源）
		rel := strings.TrimPrefix(r.URL.Path, "/")
		data, err := web.FS.ReadFile(rel)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, rel, time.Time{}, strings.NewReader(string(data)))
	})
}

// cors 跨域中间件：允许任意来源访问，并正确处理 OPTIONS 预检。
// 这样无论测试页是同源打开还是跨域（file://、其他 host）打开都能连接。
func (h *Handler) cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// auth Bearer Token 鉴权中间件。
func (h *Handler) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+h.cfg.AuthToken {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// Health 健康检查。
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "ok",
		"online_instances": h.hub.Count(),
		"instances":        h.hub.OnlineClients(),
	})
}

// CancelTask 取消进行中的任务（POST /v1/chat/cancel {"task_id":"..."}）。
// 向后端任务标记取消，并向插件实例下发 task.cancel，由插件中断网页请求。
func (h *Handler) CancelTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TaskID string `json:"task_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TaskID == "" {
		http.Error(w, `{"error":"task_id required"}`, http.StatusBadRequest)
		return
	}
	instanceID, ok := h.taskMgr.CancelTask(body.TaskID)
	if !ok {
		json.NewEncoder(w).Encode(map[string]string{"error": "task not cancellable or not found", "task_id": body.TaskID})
		return
	}
	// 向插件下发取消信令
	h.sendCancelToInstance(instanceID, body.TaskID)
	h.hub.Release(instanceID)
	json.NewEncoder(w).Encode(map[string]string{"status": "cancelled", "task_id": body.TaskID})
}

// Models 返回可用模型列表。
// 优先返回「按实例精确选择」的列表：每个在线实例一条（ID=instance_id，OwnedBy=tag），
// 调用方传入 instance_id 即可精确路由到该标签页。
// 同时保留 tag 级负载均衡入口：当同一 tag 有多个实例时，额外追加一条以 tag 为 ID 的
// 聚合模型（路由时会在该 tag 下做最少并发负载均衡）。
// 无在线实例时回退到配置中的模型列表（便于排障）。
func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	now := time.Now().Unix()
	data := make([]openai.ModelInfo, 0)
	if insts := h.hub.OnlineClients(); len(insts) > 0 {
		for _, ins := range insts {
			label := ins.Tag
			if label == "" {
				label = "instance"
			}
			data = append(data, openai.ModelInfo{
				ID:      ins.InstanceID, // 精确路由用 instance_id
				Object:  "model",
				Created: now,
				OwnedBy: label,
			})
		}
		// 同一 tag 的聚合入口（负载均衡），仅在多于 1 个实例时追加
		tagCount := map[string]int{}
		for _, ins := range insts {
			tagCount[ins.Tag]++
		}
		for tag, n := range tagCount {
			if tag != "" && n > 1 {
				data = append(data, openai.ModelInfo{
					ID:      tag, // 负载均衡入口
					Object:  "model",
					Created: now,
					OwnedBy: tag,
				})
			}
		}
	} else {
		// 无在线实例时回退到配置中的模型列表（避免下拉框空白，便于排障）。
		for _, m := range h.cfg.Models {
			data = append(data, openai.ModelInfo{
				ID:      m.ID,
				Object:  "model",
				Created: now,
				OwnedBy: m.OwnedBy,
			})
		}
	}
	json.NewEncoder(w).Encode(openai.ModelsResponse{Object: "list", Data: data})
}

// ChatCompletions 核心对话接口（兼容 OpenAI）。
func (h *Handler) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var req openai.ChatCompletionRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Model == "" {
		http.Error(w, `{"error":"model is required"}`, http.StatusBadRequest)
		return
	}
	if !h.validModel(req.Model) {
		http.Error(w, `{"error":"unsupported model: `+req.Model+`"}`, http.StatusBadRequest)
		return
	}

	taskID := "task-" + time.Now().Format("20060102") + "-" + randString(6)
	client := h.hub.Dispatch(req.Model, taskID)
	if client == nil {
		http.Error(w, `{"error":"no available instance for model `+req.Model+`"}`, http.StatusServiceUnavailable)
		return
	}
	defer h.hub.Release(client.InstanceID)

	t := h.taskMgr.Create(taskID, req.Model, client.InstanceID)

	msgs := make([]ws.WSMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		msgs = append(msgs, ws.WSMessage{Role: m.Role, Content: m.Content})
	}
	taskData := ws.TaskCreateData{
		Model:    req.Model,
		Messages: msgs,
		Stream:   req.Stream,
	}
	env := &ws.Envelope{Type: ws.TypeTaskCreate, TaskID: taskID, Data: mustRaw(taskData)}
	if err := client.Send(env); err != nil {
		h.taskMgr.Fail(taskID, "SEND_FAILED", err.Error())
		http.Error(w, `{"error":"failed to dispatch task to instance"}`, http.StatusBadGateway)
		return
	}
	log.Printf("[chat] dispatched task=%s model=%s instance=%s stream=%v", taskID, req.Model, client.InstanceID, req.Stream)

	if req.Stream {
		h.streamResponse(w, r, t, req.Model, taskID)
	} else {
		h.fullResponse(w, r, t, req.Model, taskID)
	}
}

func (h *Handler) validModel(model string) bool {
	// 1) 按实例精确选择：在线实例的 instance_id 即为合法模型名
	for _, ins := range h.hub.OnlineClients() {
		if ins.InstanceID == model {
			return true
		}
	}
	// 2) 模型名以插件实例的 Instance Tag 为准：在线实例的 tag 即为合法模型名
	for _, tag := range h.hub.OnlineTags() {
		if tag == model {
			return true
		}
	}
	// 回退：兼容配置中显式声明的模型（无在线实例时 / 直连场景）
	for _, m := range h.cfg.Models {
		if m.ID == model {
			return true
		}
	}
	// "auto" 为特殊关键字：交给后端按在线实例自动选择
	if model == "auto" {
		return true
	}
	return false
}

func (h *Handler) streamResponse(w http.ResponseWriter, r *http.Request, t *task.Task, model, taskID string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	created := time.Now().Unix()
	id := "chatcmpl-" + taskID
	for {
		select {
		case payload := <-t.DeltaCh:
			// 插件上报为完整 SSE 文本，原样透传
			io.WriteString(w, payload)
			flusher.Flush()
		case <-t.DoneCh:
			// 排空可能残留的 delta（buffered channel，非阻塞读取直到空）
			for len(t.DeltaCh) > 0 {
				payload := <-t.DeltaCh
				io.WriteString(w, payload)
				flusher.Flush()
			}
			chunk := openai.ChatCompletionChunk{
				ID:      id,
				Object:  "chat.completion.chunk",
				Created: created,
				Model:   model,
				Choices: []openai.Choice{{Index: 0, Delta: openai.Delta{}, FinishReason: strPtr("stop")}},
			}
			if b, err := chunk.MarshalSSE(); err == nil {
				io.WriteString(w, b)
			}
			io.WriteString(w, openai.DoneEvent)
			flusher.Flush()
			return
		case <-t.CancelCh:
			// 任务被取消：向插件下发 task.cancel，并发 error 帧后结束
			h.sendCancelToInstance(t.InstanceID, taskID)
			errChunk := openai.ChatCompletionChunk{
				ID:      id,
				Object:  "chat.completion.chunk",
				Created: created,
				Model:   model,
				Choices: []openai.Choice{{Index: 0, Delta: openai.Delta{}, FinishReason: strPtr("cancelled")}},
			}
			if b, err := errChunk.MarshalSSE(); err == nil {
				io.WriteString(w, b)
			}
			io.WriteString(w, openai.DoneEvent)
			flusher.Flush()
			return
		case <-r.Context().Done():
			h.taskMgr.CancelTask(taskID)
			return
		}
	}
}

func (h *Handler) fullResponse(w http.ResponseWriter, r *http.Request, t *task.Task, model, taskID string) {
	var sb strings.Builder
	created := time.Now().Unix()
	id := "chatcmpl-" + taskID
	for {
		select {
		case payload := <-t.DeltaCh:
			sb.WriteString(payload)
		case <-t.DoneCh:
			resp := openai.ChatCompletionChunk{
				ID:      id,
				Object:  "chat.completion",
				Created: created,
				Model:   model,
				Choices: []openai.Choice{{Index: 0, Delta: openai.Delta{Role: "assistant", Content: extractContent(sb.String())}, FinishReason: strPtr("stop")}},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		case <-t.CancelCh:
			h.sendCancelToInstance(t.InstanceID, taskID)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": "task cancelled", "task_id": taskID})
			return
		case <-r.Context().Done():
			h.taskMgr.CancelTask(taskID)
			w.WriteHeader(499)
			return
		}
	}
}

// truncate 截断过长字符串，便于日志打印
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}

// sendCancelToInstance 向插件实例下发 task.cancel 信令，由插件侧真正中断网页请求。
func (h *Handler) sendCancelToInstance(instanceID, taskID string) {
	h.hub.SendTo(instanceID, &ws.Envelope{Type: ws.TypeTaskCancel, TaskID: taskID})
}

// ---- helpers ----

func mustRaw(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func strPtr(s string) *string { return &s }

func extractContent(sse string) string {
	out := ""
	for _, line := range strings.Split(sse, "\n") {
		if len(line) > 6 && line[:6] == "data: " {
			chunk := line[6:]
			var c openai.ChatCompletionChunk
			if err := json.Unmarshal([]byte(chunk), &c); err == nil && len(c.Choices) > 0 {
				out += c.Choices[0].Delta.Content
			}
		}
	}
	return out
}

func randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[r.Intn(len(letters))]
	}
	_ = fmt.Sprint
	return string(b)
}
