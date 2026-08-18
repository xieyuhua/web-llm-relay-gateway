# StepFun Relay

> 通过浏览器插件把任意「Web 聊天页面」（StepFun、ChatGPT-WEB、DeepSeek 等）伪装成标准 **OpenAI 兼容** 的 `/v1/chat/completions` 接口，供上层 MCP / 客户端以 `model: chatgpt` 等方式无缝调用。
> 也就是把「网页聊天框」当成一台模型服务器来用。

---

## 0. 目录约定

| 路径 | 说明 |
|------|------|
| `cmd/main.go` | 进程入口，加载配置、初始化 Hub、启动 HTTP/WS |
| `internal/config` | YAML 配置加载（`Config` 结构） |
| `internal/http` | HTTP 路由（`/register`、`/ws`、`/v1/chat/completions`、`/v1/models`、`/v1/chat/cancel`、`/healthz`、`/`、`/test`） |
| `internal/ws` | WebSocket 连接管理、路由分发、协议编解码 |
| `internal/task` | 任务生命周期与状态机 |
| `internal/openai` | OpenAI 请求/响应 Schema 与 SSE 流式封装 |
| `web/test.html` | 调试页（由 `web/embed.go` 的 `//go:embed *.html` 内嵌进二进制） |
| `extension/` | 浏览器插件（background / content / popup / options） |
| `selectorjs` | 辅助脚本：在网页控制台点击元素，打印其 CSS 选择器（见 §12） |
| `config.yaml` | 运行配置（可选，缺失时回退内置默认值） |

> 仓库历史上曾有一个 `cmd/simws/` 模拟客户端用于本地联调，当前版本已移除（直接由 `extension/` 作为真实客户端）。如需本地模拟，可自行用任意 WebSocket 客户端实现 `instance.register` / `task.*` 协议。

---

## 1. 背景与动机

许多「网页版对话」产品没有 OpenAI 兼容 API，但上层 MCP / 应用只认 `chat/completions`。
本项目用**浏览器插件 + 中继服务器**的方式，把「在网页里打字 → 等回复」这一过程，映射成一次标准的 OpenAI 流式对话请求。

- **插件**：登录目标网页账号、打开聊天页、在后台注入脚本监听 DOM 文本变化、把回答回传给中继；
- **中继**：对上层暴露 OpenAI 风格接口，把请求转成 WebSocket 指令下发给插件，再把插件的增量回复转成 SSE 流。

---

## 2. 整体架构

```
┌──────────────┐   OpenAI 兼容 HTTP    ┌─────────────────┐   WebSocket    ┌──────────────┐
│  上层 MCP /   │ ──────── HTTP ──────▶ │  StepFun Relay  │ ────── WS ────▶ │  浏览器插件   │
│  客户端       │ ◀────── SSE ───────── │  (本仓库)        │ ◀───────────── │ (后台)        │
└──────────────┘                       └─────────────────┘                 └──────┬───────┘
                                                                                   │ 注入脚本
                                                                                   ▼
                                                                          ┌────────────────┐
                                                                          │ 目标聊天网页     │
                                                                          │ (StepFun/等)    │
                                                                          └────────────────┘
```

- **多对多**：一个中继可接入多个插件实例（`instance_id` + `tag` 区分），一个实例可声明多个 `models`。
- **负载均衡**：同 `tag` / 同 `model` 下多个在线实例，按「当前排队最短」择优选一个，同负载时轮询打散。
- **单实例串行**：每个实例内部同一时刻只执行 1 个任务，其余请求排队（见 §6.6），避免单页多对话交叉。
- **可用性**：某实例离线/忙碌，自动换下一个实例；全部不可用则返回错误。

---

## 3. 核心概念

| 概念 | 说明 |
|------|------|
| `instance_id` | 插件实例唯一 ID（由插件生成，建议含随机串以避免多开冲突） |
| `tag` | 实例分组标签，用于多实例分流（如 `chatgpt`、`deepseek`、`step`） |
| `models` | 该实例对外声明的模型名列表（用于 `/v1/models` 回退与展示） |
| `task_id` | 一次对话任务的 ID，贯穿 HTTP → WS → 回传全链路 |
| `card` | 插件侧「站点卡片」配置：URL、选择器、字段映射规则 |
| `finish_reason` | 任务结束原因：`stop` / `cancelled`（SSE）/ `timeout`（经 SSE error） |

---

## 4. 安装与运行

### 4.1 中继服务器

```bash
# 构建
go build -o relay.exe ./cmd
# 运行（可选配置文件，缺失则用内置默认值）
./relay.exe -config config.yaml
```

或：

```bash
go run ./cmd -config config.yaml
```

启动后：
- HTTP（含 WS）监听 `:8090`（内置默认，见 `config.yaml` 的 `http_addr`）；
- 浏览器访问 `http://localhost:8090/` 或 `http://localhost:8090/test` 打开调试页（`web/test.html`，已内嵌进二进制）。

### 4.2 浏览器插件

1. 打开 `chrome://extensions` → 开启「开发者模式」；
2. 「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录；
3. 在 Options 页填写本机服务地址（默认 `ws://localhost:8090/ws`）、`token`、目标站点卡片；
4. 打开对应聊天网页，插件自动连接 `/ws` 并完成注册。

> 仓库已附带 `extension.crx` / `extension.pem`（打包产物）。日常开发调试用「加载已解压」即可。

---

## 5. 配置说明（`config.yaml`）

字段以 `internal/config/config.go` 的 `Config` 结构为准。缺失项回退内置默认值（也支持环境变量 `HTTP_ADDR` / `AUTH_TOKEN` 覆盖）。

```yaml
http_addr: ":8090"          # HTTP 与 WebSocket 监听地址（默认 :8090）
ws_path: "/ws"              # WebSocket 路径（默认 /ws）
api_prefix: "/v1"           # OpenAI 接口前缀（默认 /v1）
auth_token: "sk-demo-token" # 鉴权 Token；非空时 /v1/* 与 /ws 均需携带
debug: false                # true 时打印所有 WS 收发报文

# 模型路由声明（仅用于「无在线实例时」/v1/models 回退展示；在线时以插件上报为准）
models:
  - id: "chatgpt-web"
    owned_by: "chatgpt"
    tag: "chatgpt"
  - id: "claude-web"
    owned_by: "claude"
    tag: "claude"
  - id: "auto"
    owned_by: "relay"
    tag: "auto"

rate_limit:
  enabled: false
  qps: 10
  max_tasks: 50

# 单实例串行与排队（核心能力）
concurrency:
  # 每个 WS 实例（浏览器标签页）允许排队等待的最大请求数（不含正在执行的 1 个）。
  # 0 = 严格串行，任何第 2 个并发请求立即被拒；3 = 1 个执行 + 3 个排队，第 5 个被拒。
  max_queue: 3
  # 单实例同时执行任务数（本系统强制为 1，保留字段便于未来扩展并行）。
  max_concurrent_per_instance: 1

# 单任务超时时间（秒）。从任务创建到完成（done/failed）的全局上限，
# 超时后任务被标记为 timeout 并以 SSE error 结束。默认 120。环境变量 TASK_TIMEOUT 可覆盖。
task_timeout: 120
```

> 注意：早期版本文档中提到的 `log_level`、`heartbeat`、`task.timeout`、`allowed_tags`、`field_mapping` 等字段在当前代码中**不存在**，请勿在 `config.yaml` 中配置（会被忽略）。心跳间隔/超时目前为代码内部常量；如需调整需改源码。任务超时（120s）现在已可通过 `task_timeout` 配置。

---

## 6. OpenAI 兼容接口

### 6.1 `POST /v1/chat/completions`

与标准 OpenAI 接口一致（鉴权见 §7）。关键规则：

- `model` 合法性（`validModel`）：
  1. 等于某个在线实例的 `instance_id` → 精确路由到该实例；
  2. 等于某个在线实例的 `tag` → 路由到该 tag 分组；
  3. 等于 `config.models` 中某个 `id` → 配置回退（无在线实例时仍可用）；
  4. 等于特殊关键字 `auto` → 由中继在所有在线实例中择优。
- `messages`：`[{role, content}]`，必需。
- `stream`：`true` 时返回 SSE 增量流；`false` 时返回完整 JSON。
- `temperature` / `max_tokens` 等透传，但中继不强制在网页侧使用。

**错误码**

| HTTP | 场景 |
|------|------|
| `400` | `model` 为空 / 不支持（`validModel` 不通过） / 请求体非法 |
| `401` | 未带或错误 `auth_token` |
| `503` | 没有可承接该 `model` 的在线实例；或该实例**排队已满**（系统繁忙） |
| `502` | 任务已下发但 WS 发送失败 |
| `500` | 非流式任务在等待中被取消 |

> 超时（`config.yaml` 中 `task_timeout` 配置，默认 120s）不会返回 HTTP 504，而是以 SSE `error` 事件结束流式响应。
> 排队已满时返回 `503`，响应体：`{"error":"系统繁忙，请稍后再试（服务器并发已达上限）"}`。

响应（非流式）示例：

```json
{
  "id": "chatcmpl-task-...",
  "object": "chat.completion",
  "model": "chatgpt",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop" }
  ]
}
```

SSE（流式）逐片：

```
data: {"choices":[{"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### 6.2 `GET /v1/models`

返回在线实例的模型列表：
- **每个在线实例一条**：`id` = 该实例的 `instance_id`，`owned_by` = 实例 `tag`（供「按实例精确路由」）；
- **同 `tag` 多实例时**，额外追加一条 `id = tag` 的聚合入口（供该 tag 内负载均衡）；
- 无在线实例时，回退到 `config.models` 中声明的列表（避免下拉框空白，便于排障）。

```json
{ "object": "list", "data": [
  { "id": "inst-xxxx", "object": "model", "owned_by": "chatgpt" },
  { "id": "chatgpt",   "object": "model", "owned_by": "chatgpt" }
] }
```

### 6.3 `POST /v1/chat/cancel`

```json
{ "task_id": "uuid" }
```

取消进行中的任务（客户端主动中断流式读取时通常由 SDK 自动触发）。中继向插件实例下发 `task.cancel`，由插件侧 `AbortController.abort()` 中断页面请求。返回 `{ "status": "cancelled", "task_id": "..." }` 或错误。

> `/v1/chat/cancel` 同样受 `auth_token` 保护（与 `chat/completions` 同源鉴权）。

### 6.4 `GET /healthz`

无需鉴权。返回在线实例数与实例明细：

```json
{ "status": "ok", "online_instances": 2,
  "instances": [ { "instance_id": "...", "tag": "chatgpt", "models": "chatgpt", "online": true, "tasks": 0 } ] }
```

### 6.5 `GET /` 与 `GET /test`

内置调试页（`web/test.html`），用于手动构造 `chat/completions` 请求并观察 SSE 输出。

### 6.6 单实例串行与排队控制

这是本系统的核心并发约束：**每个 WS 实例（即一个浏览器标签页）同一时刻只允许 1 个客户端在网页上操作**，避免多个对话在同一页面上交叉、互相污染。

- **串行执行**：实例内部维护一个 FIFO 队列，`serve()` 协程每次只把队首任务通过 `task.create` 下发给插件；该任务 `done` 后才处理下一个。
- **可配置排队**：`config.yaml` 的 `concurrency.max_queue` 控制「除正在执行的 1 个外，还能排队多少个」。默认 `3`（即 1 执行 + 3 等待）。
  - `max_queue: 0` → 严格串行，第 2 个并发请求立即被拒（最严格，适合单账号防风控）。
  - `max_queue: N` → 允许 N 个请求挂起等待，对客户端表现为「稍等片刻」。
- **排队满拒绝**：当某实例队列已达 `max_queue`，新请求入队时返回 `503`，响应体 `{"error":"系统繁忙，请稍后再试（服务器并发已达上限）"}`，**不会卡住连接**。
- **多实例并行**：同一 `tag` 下若有多个插件实例在线，网关按「队列最短」择优路由，各实例各自串行、彼此并行，从而横向扩展吞吐。
- **不丢任务**：排队的 HTTP 连接保持打开（SSE 挂起），前面任务结束后自动被调度执行；任务自身 `task_timeout`（默认 120s）超时保护同样覆盖排队阶段，不会死锁。

> 实现位置：`internal/ws/client.go`（`queue` + `serve()`）、`internal/ws/hub.go`（`Enqueue` / `ErrBusy`）、`internal/http/router.go`（`ChatCompletions` 入队与 503 处理）、`internal/config/config.go`（`Concurrency`）。

---

## 7. 鉴权

`auth_token` 非空时：

- 所有 `/v1/*` 接口需带 `Authorization: Bearer <token>`（缺失/错误返回 `401`）；
- WebSocket `/ws` 连接需在 query 带 `?token=<token>`（`wsToken` 非空时强制校验，失败直接关闭连接）；
- 调试页 `web/test.html` 与插件 Options 都让你填 `auth_token`，需与中继一致。

---

## 8. 实例注册与心跳

插件连接 `ws://<host>/ws?instance_id=...&tag=...&models=...&token=...` 后：

- 服务端从 query 自动注册（`instance_id` 为空则不注册，仅保持连接）；
- 也可发送 `instance.register` 消息体（`{instance_id, tag, models}`）进行显式注册；
- 注册成功回 `register.ack`；
- 服务端周期（约 30s）发 `ping`，插件回 `pong`，`LastPing` 用于存活判断。

> 说明：`config.yaml` 当前没有 `allowed_tags` 白名单机制；任何能带正确 `token` 的实例均可注册。

---

## 9. 任务编排与状态机

```
created ──▶ running ──▶ done(finish_reason=stop)
   │
   ├──▶ cancelled(finish_reason=cancelled / HTTP 500)
   └──▶ timeout(task_timeout 默认 120s, SSE error 事件)
```

- 中继收到 `/v1/chat/completions` → 生成 `task_id`（形如 `task-<日期>-<随机>`）→ 选实例 → 下发 `task.create`；
- 插件回 `task.ack`（可选）→ 周期性回 `task.delta`（增量文本，已是完整 SSE 文本原样透传）→ 回 `task.done`（含 `finish_reason`）；
- 出错回 `task.error`（`code` + `message`）；
- 中继按 `task_id` 把增量拼成 SSE 推给上层；
- 超时或 `max_rounds` 触顶 → 强制结束（SSE error）；
- 取消：客户端调 `/v1/chat/cancel` → 中继下发 `task.cancel` → 插件中断页面请求。

**`task.create` 下行数据（中继 → 插件）**

协议字段（`internal/ws/protocol.go` 的 `TaskCreateData`）包含：

```json
{ "type": "task.create",
  "task_id": "uuid",
  "data": {
    "model": "chatgpt",
    "messages": [{"role":"user","content":"hi"}],
    "stream": true,
    "selector": "",
    "send_button_selector": "",
    "answer_selector": ""
  } }
```

> 注意：中继当前**只填充** `model` / `messages` / `stream` 三个字段；`selector` / `send_button_selector` / `answer_selector` 字段保留在协议中但由**插件侧**在 `task.run` 派发时从「站点卡片配置」注入。元素定位完全在插件侧完成，中继只负责路由与文本回传。

---

## 10. 字段映射规则（插件侧为主）

插件「站点卡片」支持两类字段映射，用于把网页 DOM 文本抽取成结构化消息：

**A. 简单映射（数组，按 selector 顺序）**

```json
{ "selector": ".user-msg", "field": "user", "type": "text" }
{ "selector": ".bot-msg",  "field": "bot",  "type": "text" }
```

**B. 条件映射（对象，带 `when` 判定，避免页面多区域误匹配）**

```json
{ "when": { "selector": ".role-label", "text": "我" },
  "then": { "selector": ".content", "field": "user", "type": "text" } }
```

支持的 `type`：`text` / `json` / `raw` / `map`。

> 早期设计曾把「字段映射」描述为后端 `config.yaml` 的全局 `field_mapping`，但当前 `Config` 结构**不含该字段**，字段映射完全在插件 Options 卡片里配置。以插件侧配置为准。

---

## 11. 插件内部结构

| 文件 | 职责 |
|------|------|
| `background.js` | WS 客户端、任务路由、`instance.register`/`task.*` 收发、心跳保活、多实例重连 |
| `content.js` | 注入目标页；转发插件↔页面消息；暴露选择器工具 |
| `pageBridge.js` | **主世界（Main World）** 脚本：直接操作页面 DOM、轮询/监听回答、抓取最终文本 |
| `bridge.js` | content ↔ background 的桥接通道 |
| `popup.js` | 弹窗：显示服务地址、连接状态、快速开关 |
| `options.js` | 选项页：增删站点卡片（URL/选择器/字段映射/手动对话开关）；内置 `stepfun` 预设 |
| `manifest.json` | 扩展清单（权限、content_scripts、background service worker） |
| `popup.html` / `options.html` / `style.css` | 界面 |

### 11.1 两种对话模式

- **自动模式**（默认）：插件自动填表、点发送、监听回答、回传。
- **手动对话模式**：开启后插件只负责抓取「已存在对话」的最终回答，不自动发送。适合需要人工介入或规避风控的场景。

### 11.2 调试

- 中继侧：`debug: true` 会打印所有 WS 收发报文（含截断的长文本）；
- 插件侧：Options 页「调试开关」开启后，控制台输出任务生命周期与 DOM 抓取详情；
- 调试页 `web/test.html` 可手动构造 `chat/completions` 请求、观察返回。

---

## 12. `selectorjs` 辅助脚本

根目录的 `selectorjs`（无扩展名）是一个**独立的浏览器控制台小工具**，用途：在目标聊天网页的开发者控制台里运行它，点击页面元素后自动打印该元素的 CSS 选择器，便于你在插件 Options 卡片里填写 `selector` / `send_button_selector` / `answer_selector`。

使用方式（两种之一）：

1. 直接把 `selectorjs` 文件内容粘贴到浏览器控制台执行；
2. 或把它当作书签脚本（bookmarklet）保存，打开网页后点击该书签激活「点击取选择器」模式。

激活后：鼠标悬停/点击任意元素，控制台即输出类似 `body > div.app > div.main > textarea#prompt` 的选择器字符串，复制填入插件配置即可。

---

## 13. 运维与排错

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 请求返回 `400 unsupported model` | `model` 无匹配实例 / 未注册 / 非 `auto` | 检查插件是否已连接并注册；`/v1/models` 或 `/healthz` 看实例 |
| 请求返回 `503` | 无在线实例 / 实例排队已满（系统繁忙） | 检查插件 WS 是否连上、token 是否正确；多 agent 并发时调大 `concurrency.max_queue` 或增开同 `tag` 实例 |
| 流式只收到一部分就断 | 实例心跳超时被判离线 | 检查浏览器是否休眠回收 SW；开 `debug` 看报文 |
| 抓取到的回答为空/错乱 | 选择器/字段映射不准 | 用 `selectorjs` 重新取选择器；开调试模式看 DOM |
| 全部实例都接单失败 | 目标网页改版 / 登录失效 | 插件侧处理，中继只透传 `task.error` |

---

## 14. 安全提示

- `auth_token` 仅用于上层↔中继的接口鉴权以及 `/ws` 注册校验，**不加密** WebSocket 本身；生产环境请在 `localhost` 或反代（HTTPS + Basic/Bearer）后使用。
- 插件以你的登录态操作目标网页，等同于「你在网页上聊天」；请勿把中继暴露到不可信网络。
- 当前 `Config` 无 `allowed_tags` 白名单，任何持正确 token 的实例均可注册，请通过 token 与网络隔离控制接入范围。

---

## 15. 相关文档

- `PRD.md`：产品需求文档（目标用户、使用场景、验收标准），已与当前代码实现对齐。
