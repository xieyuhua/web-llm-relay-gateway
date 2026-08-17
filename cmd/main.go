package main

import (
	"flag"
	"log"
	nethttp "net/http"
	"os"

	"gateway/internal/config"
	httphandler "gateway/internal/http"
	"gateway/internal/task"
	"gateway/internal/ws"

	"github.com/gorilla/websocket"
)

func main() {
	debugFlag := flag.Bool("debug", false, "debug 模式：打印客户端连接信息与会话收发原文")
	flag.Parse()

	cfg := config.Load("config.yaml")
	// 启动参数 -debug 或环境变量 RELAY_DEBUG 或 config.yaml 的 debug 任一为真即开启
	debug := *debugFlag || cfg.Debug || os.Getenv("RELAY_DEBUG") == "1" || os.Getenv("RELAY_DEBUG") == "true"

	taskMgr := task.NewManager()
	hub := ws.NewHub(taskMgr, cfg.AuthToken, debug)
	handler := httphandler.New(cfg, hub, taskMgr)

	mux := nethttp.NewServeMux()
	handler.Register(mux)

	// WebSocket 升级端点（插件连接）
	upgrader := websocket.Upgrader{CheckOrigin: func(r *nethttp.Request) bool { return true }}
	mux.HandleFunc(cfg.WSPath, func(w nethttp.ResponseWriter, r *nethttp.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws] upgrade failed: %v", err)
			return
		}
		hub.UpgradeAndServe(conn, r)
	})

	log.Printf("[gateway] listening on %s (api=%s, ws=%s) debug=%v", cfg.HTTPAddr, cfg.APIPrefix, cfg.WSPath, debug)
	if err := nethttp.ListenAndServe(cfg.HTTPAddr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
