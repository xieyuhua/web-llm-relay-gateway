package config

import (
	"os"
	"strconv"

	"gopkg.in/yaml.v3"
)

// Config 运行时配置。
type Config struct {
	HTTPAddr    string        `yaml:"http_addr"`
	WSPath      string        `yaml:"ws_path"`
	APIPrefix   string        `yaml:"api_prefix"`
	AuthToken   string        `yaml:"auth_token"`
	Debug       bool          `yaml:"debug"`
	Models      []ModelRoute  `yaml:"models"`
	RateLimit   RateLimit     `yaml:"rate_limit"`
	Concurrency Concurrency   `yaml:"concurrency"`
	// TaskTimeout 任务超时时间（秒）。单个对话任务从创建到完成的全局上限，
	// 超时后任务被标记为 timeout 并失败。默认 120 秒。
	TaskTimeout int `yaml:"task_timeout"`
}

// Concurrency 单实例并发与排队配置。
// 约束：每个 WS 实例（插件）同一时刻只允许 1 个客户端在网页上操作；
// 其余请求进入排队队列，队列满后直接拒绝（返回 503 系统繁忙）。
type Concurrency struct {
	// MaxQueue 每个实例允许排队等待的最大请求数（不含正在执行的 1 个）。
	// 0 表示严格串行，不允许任何等待，第二个并发请求立即被拒。
	MaxQueue int `yaml:"max_queue"`
	// MaxConcurrentPerInstance 单实例同时执行的任务数（本系统强制为 1，保留字段便于扩展）。
	MaxConcurrentPerInstance int `yaml:"max_concurrent_per_instance"`
}

// ModelRoute 模型路由配置。
type ModelRoute struct {
	ID      string `yaml:"id"`
	OwnedBy string `yaml:"owned_by"`
	Tag     string `yaml:"tag"`
}

// RateLimit 速率限制配置。
type RateLimit struct {
	Enabled  bool `yaml:"enabled"`
	QPS      int  `yaml:"qps"`
	MaxTasks int  `yaml:"max_tasks"`
}

// Default 返回内置默认配置。
func Default() *Config {
	return &Config{
		HTTPAddr:  getenv("HTTP_ADDR", ":8090"),
		WSPath:    "/ws",
		APIPrefix: "/v1",
		AuthToken: getenv("AUTH_TOKEN", "sk-demo-token"),
		Models: []ModelRoute{
			{ID: "chatgpt-web", OwnedBy: "chatgpt", Tag: "chatgpt"},
			{ID: "claude-web", OwnedBy: "claude", Tag: "claude"},
			{ID: "auto", OwnedBy: "relay", Tag: "auto"},
		},
		RateLimit: RateLimit{Enabled: false, QPS: 10, MaxTasks: 50},
		Concurrency: Concurrency{MaxQueue: 3, MaxConcurrentPerInstance: 1},
		TaskTimeout: getenvInt("TASK_TIMEOUT", 120),
	}
}

// Load 优先读取 config.yaml，缺失项回退到 Default + 环境变量。
func Load(path string) *Config {
	cfg := Default()
	if path == "" {
		path = "config.yaml"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		// 无配置文件则用默认 + 环境变量
		return cfg
	}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		// 解析失败仍使用默认
		return Default()
	}
	// 环境变量覆盖
	if v := os.Getenv("HTTP_ADDR"); v != "" {
		cfg.HTTPAddr = v
	}
	if v := os.Getenv("AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
	}
	if v := os.Getenv("TASK_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TaskTimeout = n
		}
	}
	if cfg.WSPath == "" {
		cfg.WSPath = "/ws"
	}
	if cfg.APIPrefix == "" {
		cfg.APIPrefix = "/v1"
	}
	return cfg
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
