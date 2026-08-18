package task

import (
	"log"
	"sync"
	"time"
)

// Status 任务状态。
type Status string

const (
	StatusCreated   Status = "created"
	StatusRunning   Status = "running"
	StatusDone      Status = "done"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
	StatusTimeout   Status = "timeout"
)

// Task 单次对话任务生命周期单元。
type Task struct {
	ID          string
	Model       string
	InstanceID  string
	Status      Status
	CreatedAt   int64
	FinishedAt  int64
	ErrCode     string
	ErrMessage  string
	DeltaCh     chan string
	DoneCh      chan struct{}
	CancelCh    chan struct{}
	timeout     *time.Timer
}

// Manager 任务管理器（内存 sync.Map）。
type Manager struct {
	mu         sync.RWMutex
	tasks      map[string]*Task
	taskTimeout time.Duration
}

// NewManager 创建管理器。timeout 为单任务超时上限，<=0 时回退到 120s。
func NewManager(timeout time.Duration) *Manager {
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	return &Manager{tasks: make(map[string]*Task), taskTimeout: timeout}
}

// Create 创建任务并启动超时计时（超时时长由 NewManager 配置决定，默认 120s）。
func (m *Manager) Create(id, model, instanceID string) *Task {
	t := &Task{
		ID:         id,
		Model:      model,
		InstanceID: instanceID,
		Status:     StatusCreated,
		CreatedAt:  time.Now().Unix(),
		DeltaCh:    make(chan string, 256),
		DoneCh:     make(chan struct{}),
		CancelCh:   make(chan struct{}),
	}
	t.timeout = time.AfterFunc(m.taskTimeout, func() {
		m.Fail(id, "TASK_TIMEOUT", "task exceeded "+m.taskTimeout.String())
	})
	m.mu.Lock()
	m.tasks[id] = t
	m.mu.Unlock()
	return t
}

// Get 获取任务。
func (m *Manager) Get(id string) (*Task, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.tasks[id]
	return t, ok
}

// OnAck 插件确认接收，转 running。
func (m *Manager) OnAck(id string) {
	if t, ok := m.Get(id); ok {
		t.Status = StatusRunning
		log.Printf("[task] %s acked", id)
	}
}

// OnDelta 收到流式增量，推入 DeltaCh。
// 使用非阻塞写入：一旦 DeltaCh（容量 256）被消费方（HTTP SSE 写出）积压填满，
// 直接丢弃该帧并告警，绝不在 readLoop 中阻塞——否则 readLoop 卡住后将不再
// 从 socket 读消息，导致整条 WS 连接僵死（插件侧已回写，但 Go 侧无法再读/转发）。
func (m *Manager) OnDelta(id, payload string) {
	t, ok := m.Get(id)
	if !ok || t.Status == StatusDone || t.Status == StatusFailed {
		return
	}
	select {
	case t.DeltaCh <- payload:
	default:
		log.Printf("[task] %s delta channel full, drop a delta frame (consumer too slow)", id)
	}
}

// OnDone 任务完成。
func (m *Manager) OnDone(id, finishReason string) {
	if t, ok := m.Get(id); ok {
		if t.Status == StatusDone || t.Status == StatusFailed {
			return
		}
		t.Status = StatusDone
		t.FinishedAt = time.Now().Unix()
		if t.timeout != nil {
			t.timeout.Stop()
		}
		close(t.DoneCh)
		log.Printf("[task] %s done (reason=%s)", id, finishReason)
	}
}

// Fail 标记任务失败。
func (m *Manager) Fail(id, code, message string) {
	if t, ok := m.Get(id); ok {
		if t.Status == StatusDone || t.Status == StatusFailed || t.Status == StatusTimeout {
			return
		}
		t.Status = StatusFailed
		t.ErrCode = code
		t.ErrMessage = message
		t.FinishedAt = time.Now().Unix()
		if t.timeout != nil {
			t.timeout.Stop()
		}
		close(t.DoneCh)
		log.Printf("[task] %s failed: %s %s", id, code, message)
	}
}

// Timeout 返回单任务超时配置（供 serve 兜底等待使用）。
func (m *Manager) Timeout() time.Duration {
	return m.taskTimeout
}

// TimeoutTask 主动把未终态的任务标记超时并安全释放 DoneCh。
// 供 ws serve 兜底使用：当插件漏报 task.done 时，避免实例被单个任务永久占用。
// 幂等：已终态（done/failed/cancelled/timeout）直接跳过，绝不重复 close DoneCh。
func (m *Manager) TimeoutTask(id string) {
	if t, ok := m.Get(id); ok {
		if t.Status == StatusDone || t.Status == StatusFailed || t.Status == StatusCancelled || t.Status == StatusTimeout {
			return
		}
		t.Status = StatusTimeout
		t.ErrCode = "TASK_TIMEOUT"
		t.ErrMessage = "task exceeded " + m.taskTimeout.String()
		t.FinishedAt = time.Now().Unix()
		if t.timeout != nil {
			t.timeout.Stop()
		}
		close(t.DoneCh)
		log.Printf("[task] %s timeout", id)
	}
}

// CancelTask 取消任务，返回其所属实例 ID（供上层向插件下发 task.cancel）。
// 已终态（done/failed）的任务不可取消，返回 ok=false。
func (m *Manager) CancelTask(id string) (instanceID string, ok bool) {
	t, found := m.Get(id)
	if !found {
		return "", false
	}
	if t.Status == StatusDone || t.Status == StatusFailed || t.Status == StatusCancelled {
		return "", false
	}
	t.Status = StatusCancelled
	t.FinishedAt = time.Now().Unix()
	if t.timeout != nil {
		t.timeout.Stop()
	}
	select {
	case <-t.CancelCh:
	default:
		close(t.CancelCh)
	}
	// 不关闭 DoneCh：由 handler 在 CancelCh 触发后发送 error/终止帧
	log.Printf("[task] %s cancelled (instance=%s)", id, t.InstanceID)
	return t.InstanceID, true
}

// OnInstanceGone 实例断线时，将其关联任务标记失败。
func (m *Manager) OnInstanceGone(instanceID string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, t := range m.tasks {
		if t.InstanceID == instanceID && t.Status != StatusDone && t.Status != StatusFailed {
			m.Fail(t.ID, "INSTANCE_GONE", "plugin instance disconnected")
		}
	}
}
