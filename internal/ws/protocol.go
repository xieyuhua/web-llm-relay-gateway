package ws

import "encoding/json"

// Envelope 内部私有协议消息信封。
type Envelope struct {
	Type   string          `json:"type"`
	TaskID string          `json:"task_id,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

// 消息类型常量（下行 Golang→插件 / 上行 插件→Golang）。
const (
	// 下行
	TypeTaskCreate  = "task.create"
	TypeTaskCancel  = "task.cancel"
	TypePing        = "ping"
	TypeRegisterAck = "register.ack"
	// 上行
	TypeRegister = "instance.register"
	TypeTaskAck  = "task.ack"
	TypeTaskDelta = "task.delta"
	TypeTaskDone = "task.done"
	TypeTaskError = "task.error"
	TypePong     = "pong"
)

// TaskCreateData 下行任务数据。保留完整 messages，避免 role 结构丢失。
type TaskCreateData struct {
	Model            string       `json:"model"`
	Messages         []WSMessage  `json:"messages"`
	Selector         string       `json:"selector"`
	SendButton       string       `json:"send_button_selector"`
	AnswerSelector   string       `json:"answer_selector"`
	Stream           bool         `json:"stream"`
}

// WSMessage 下发给插件的单条对话消息。
type WSMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// RegisterData 插件实例注册数据。
type RegisterData struct {
	InstanceID string   `json:"instance_id"`
	Tag        string   `json:"tag"`
	Models     []string `json:"models"`
}

// DeltaData 上行流式增量（SSE 文本透传）。
type DeltaData struct {
	Format  string `json:"format"`  // "sse"
	Payload string `json:"payload"` // OpenAI chunk SSE 文本
}

// DoneData 上行完成数据。
type DoneData struct {
	FinishReason string `json:"finish_reason"`
}

// ErrorData 上行错误数据。
type ErrorData struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PingData 心跳数据。
type PingData struct {
	Ts int64 `json:"ts"`
}
