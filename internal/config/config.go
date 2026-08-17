package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Config 运行时配置。
type Config struct {
	HTTPAddr   string        `yaml:"http_addr"`
	WSPath     string        `yaml:"ws_path"`
	APIPrefix  string        `yaml:"api_prefix"`
	AuthToken  string        `yaml:"auth_token"`
	Debug      bool          `yaml:"debug"`
	Models     []ModelRoute  `yaml:"models"`
	RateLimit  RateLimit     `yaml:"rate_limit"`
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
