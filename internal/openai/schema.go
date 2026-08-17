package openai

import "encoding/json"

// ChatCompletionRequest 对外 OpenAI-compatible 请求体（子集）。
type ChatCompletionRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Stream      bool      `json:"stream"`
	Temperature float64   `json:"temperature,omitempty"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
}

// Message 单条对话消息。
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatCompletionChunk 对外 SSE 流式 chunk（OpenAI 兼容）。
type ChatCompletionChunk struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
}

// Choice 流式选择项。
type Choice struct {
	Index        int     `json:"index"`
	Delta        Delta   `json:"delta"`
	FinishReason *string `json:"finish_reason,omitempty"`
}

// Delta 增量内容。
type Delta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

// ModelInfo / ModelsResponse 对应 GET /v1/models。
type ModelsResponse struct {
	Object string      `json:"object"`
	Data   []ModelInfo `json:"data"`
}

type ModelInfo struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

// BuildPrompt 将 messages 合并为单段 prompt（兜底用，优先仍保留完整 messages）。
func BuildPrompt(msgs []Message) string {
	out := ""
	for _, m := range msgs {
		out += m.Role + ": " + m.Content + "\n"
	}
	return out
}

// MarshalSSE 将 chunk 编码为 SSE "data: ..." 文本。
func (c ChatCompletionChunk) MarshalSSE() (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return "data: " + string(b) + "\n\n", nil
}

// DoneEvent SSE 结束标记。
const DoneEvent = "data: [DONE]\n\n"
