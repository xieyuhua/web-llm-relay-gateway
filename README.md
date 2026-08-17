# 网页大模型聚合网关 (Web LLM Relay Gateway)

把「已登录的网页版大模型」（ChatGPT / Claude / StepFun / Gemini 等）包装成标准 **OpenAI-compatible `/v1/chat/completions`** 接口，让任意兼容 OpenAI SDK 的客户端（Python / Node / curl / Agent 框架）直接驱动网页模型——**无需逆向官方 API、无需自备 Key、凭据始终留在浏览器本地**。

> 本仓库实现 PRD v1.0 端到端最小可跑版本：Golang 后端 + Chrome MV3 插件。

---

## 1. 它能做什么

- **OpenAI 兼容**：`/v1/chat/completions`（`stream=true/false`）、`/v1/models`、`/healthz`、取消接口。
- **多实例聚合**：多个浏览器标签页（甚至多台机器）上的插件实例，按 `tag` 分组路由，支持同 tag 下「并发最少者优先 + 轮询」负载均衡；也支持**按 `instance_id` 精确路由到某个具体标签页**。
- **网页无关**：输入框 / 发送按钮 / 对话接口路径 / SSE 字段结构全部在 Options 中手动配置，不写死适配某个站点。
- **选择器任意复杂**：支持任意原生 CSS 选择器（含组合符 `>`、`+`、`~`，伪类 `:not()`、属性选择器 `[variant=inset]`），也支持 XPath（以 `//`、`/html`、`(//` 开头自动识别）。子 iframe 内元素自动跨 frame 定位。
- **多标签页独立监听 + 独立网关连接**：每个选项卡 = 一个网页 = 一套**完整独立配置**（独立 WS URL / Token / Tag / 模型 / 选择器 / 字段映射），可分别连接不同网关。
- **双世界流式捕获**：
  - `bridge.js`：注入页面**隔离世界**（content script 上下文），拦截页面 `fetch` / `XMLHttpRequest` 流式响应。
  - `pageBridge.js`：注入页面**主世界**（`world: 'MAIN'`），直接 hook 页面真实 `fetch` / `XHR` / 原生 `EventSource`，可抓取隔离世界看不到的请求（部分站点真实请求只发生在主世界）。两者互补，覆盖绝大多数站点。
- **兜底**：上述拦截通道因 CSP 受限时，`content.js` 用 `MutationObserver` 监听回答区节点回传新增文本。
- **实例自动注册 + 鉴权**：插件连接网关即自动注册（无需手工预申报），网关强制校验 `token`，杜绝伪造实例。

---

## 2. 整体架构

```
终端调用方 (OpenAI SDK / curl / Agent)
   │  POST /v1/chat/completions (SSE)
   ▼
Golang 后端 (main.exe)
   │  WebSocket (内部 JSON 协议，?token= 鉴权)
   ▼
浏览器插件 (MV3, background.js)
   │  content script → 网页 JS 桥接（隔离世界 + 主世界）
   ▼
网页版大模型 (已登录)
```

**两种使用模式**：

| 模式 | 是否经后端 | 触发方式 | 回传展示 |
|---|---|---|---|
| **手动模式** | 否（纯本地） | Popup 选标签页 → 输入 → 发送 | 弹窗内流式展示 |
| **接口驱动模式** | 是 | 任意 OpenAI 客户端 `POST /v1/chat/completions` | 经 WS 上行 → 后端透传 OpenAI SSE |

---

## 3. 目录结构

```
.
├── cmd/
│   ├── main.go          # 后端入口（读取 config.yaml，装配 Hub/TaskManager/HTTP Handler）
│   └── simws/           # 模拟插件 WS 客户端（测试用，无需真实浏览器）
├── internal/
│   ├── config/          # 运行时配置（config.yaml 解析）
│   ├── http/            # HTTP 路由 (chat/models/health/cancel) + SSE 透传
│   ├── ws/              # WebSocket Hub + 协议 + 客户端封装 + 负载均衡路由
│   ├── task/            # 任务状态机 + 120s 超时 + 取消
│   └── openai/          # OpenAI schema（请求/响应/SSE 序列化）
├── web/                 # 内置测试网页（embed 进二进制）
│   └── test.html        # 网关对接测试台
├── extension/           # 浏览器插件 (MV3) —— 加载此目录
│   ├── manifest.json
│   ├── background.js    # WS 客户端 + 任务编排 + 指数退避重连 + 实例自动注册
│   ├── content.js       # DOM 操控 + MutationObserver 兜底 + 元素探测 + 回传转发
│   ├── bridge.js        # 注入【隔离世界】拦截 fetch/XHR 流式 + AbortController
│   ├── pageBridge.js    # 注入【主世界】hook 真实 fetch/XHR/EventSource 流式
│   ├── popup.html/js    # 手动模式弹窗 + 实例连接状态面板 + 元素探测开关
│   ├── options.html/js  # 每标签页独立配置：WS 地址 / Token / Tag / 选择器 / SSE 字段映射
│   └── style.css
├── main.exe             # 编译产物（Windows）
├── config.yaml          # 运行时配置
└── go.mod
```

> ⚠️ **加载目录**：Chrome 加载的是 `extension/` 目录（manifest 所在）。`extension - 副本/` 等其它目录不会被加载，请勿混淆。

---

## 4. 后端运行

```powershell
$env:GOPROXY="off"        # 离线环境用本地缓存；正常联网可省略
go build -o main.exe ./cmd
.\main.exe
```

后端默认读取同目录 `config.yaml`，监听地址下的 WebSocket 路径为 `/ws`。

### 4.1 `config.yaml`

```yaml
# 网页大模型聚合网关配置
http_addr: ":8191"          # 监听地址，环境变量 HTTP_ADDR 可覆盖
ws_path: "/ws"              # WebSocket 升级路径
api_prefix: "/v1"           # OpenAI API 前缀
auth_token: "sk-demo-token" # Bearer Token，环境变量 AUTH_TOKEN 可覆盖

# 模型路由表：对外 model 名 -> 插件实例 tag
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
```

环境变量覆盖：`HTTP_ADDR`（→ `http_addr`）、`AUTH_TOKEN`（→ `auth_token`）。

> 注意：`auth_token` 同时保护 `/v1/*`（Bearer）与 `/ws`（query `?token=`），二者必须一致。

### 4.2 接口一览

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `GET /` 或 `/test` | GET | 否 | 内置测试网页（自检对接是否成功） |
| `GET /healthz` | GET | 否 | 健康检查（在线实例数 + 实例明细） |
| `GET /v1/models` | GET | 是 | 模型列表（每在线实例一条，ID=`instance_id`；同 tag 多实例额外追加 tag 聚合入口） |
| `POST /v1/chat/completions` | POST | 是 | 核心对话（支持 `stream=true/false`） |
| `POST /v1/chat/cancel` | POST | 是 | 取消进行中任务，body `{"task_id":"..."}` |
| `GET /ws` | GET(WS) | 是 | 插件 WebSocket 注册通道（`?token=` 必填，与 `auth_token` 一致），query 带 `instance_id`/`tag`/`models` 自动注册 |

---

## 5. 实例模型与路由规则

`/v1/chat/completions` 的 `model` 字段按优先级解析：

1. **精确 `instance_id`**：若 `model` 等于某在线实例的 `instance_id`（形如 `inst-<前缀>-<tabId>`），则路由到该**具体标签页**。
2. **tag 名**：若 `model` 等于某在线实例上报的 `tag`（如 `chatgpt`、`chatgpt-web-3`），则在该 tag 下所有在线实例中按「并发最少 + 轮询」负载均衡。
3. **配置 model / `auto`**：回退到 `config.yaml` 的 `models` 声明；`auto` 表示在全部在线实例中择优。

> ⚠️ **tag 不要被截断**：`model: "chatgpt-web-3"` 会与实例上报的 `tag=chatgpt-web-3` 精确匹配。前提是 Options 里该标签页的「Instance / 路由 Tag」填的是 `chatgpt-web-3` 并已保存。

`instance_id` 由插件自动生成并**持久化**（按浏览器 profile 固定前缀 + 标签页 id 后缀），service worker 重启后保持稳定，`/models` 与 `/healthz` 计数不会抖动。

---

## 6. 流式回传链路（核心）

这是本项目最易踩坑的部分。两种模式、两条脚本世界，回传路径不同。

### 6.1 隔离世界通道（`bridge.js`）

`bridge.js` 由 content script 注入（manifest 自动注入 + 动态 `executeScript`），运行在**隔离世界**，可拦截页面 `fetch` 流式：

```
页面 fetch 响应 (SSE 流)
   └─ bridge.js 拦截 → 按 chatApi/sseField 解析 delta
        └─ chrome.runtime.sendMessage({ type:'bridge.delta'/'bridge.done' })
             └─ background.js → 转发给 popup(手动) 或 WS(接口驱动)
```

### 6.2 主世界通道（`pageBridge.js`）

`pageBridge.js` 由 popup/background 以 `world: 'MAIN'` 注入到**主世界**，直接 hook 页面真实 `fetch` / `XMLHttpRequest` / `EventSource`：

```
页面真实请求响应
   └─ pageBridge.js hook (fetch / xhr / eventsource 三路之一)
        └─ window.postMessage({ __pageBridge:'delta'/'done', content })
             └─ content.js 监听 __pageBridge 消息
                  └─ chrome.runtime.sendMessage({ type:'task.delta'/'task.done', task_id })
                       └─ background.js → popup(手动) 或 WS(接口驱动)
```

> **何时走哪条通道**：`bridge.js`（隔离世界）只能看到跨世界可见的 fetch 调用；部分站点真实请求发生在主世界、隔离世界拦截不到，此时由 `pageBridge.js`（主世界）兜底。两者都配置好后，**命中任一即可回传**，互不冲突。

### 6.3 控制台来源标签

`pageBridge.js` 打印日志已带来源标签，便于排查到底哪条通道在工作：

```
[pageBridge:fetch]        # 来自 fetch 流式 ReadableStream
[pageBridge:xhr]          # 来自 XMLHttpRequest 轮询 responseText 增量
[pageBridge:eventsource]  # 来自原生 EventSource
```

若确认某站点走的是哪一路，可据此判断是否需要调整 `chatApi` 配置或启用主世界 hook。

### 6.4 兜底通道（MutationObserver）

当 CSP 禁止 fetch 拦截、且主世界 hook 也未命中时，`content.js` 用 `MutationObserver` 监听回答区节点，按「差异选择器」回传新增文本。此通道首字延迟略高且无法精确取消。

---

## 7. 端到端时序（一轮对话）

1. 客户端 `POST /v1/chat/completions` → 后端按 `model` 路由到目标实例，创建任务并 `Dispatch`。
2. 后端经 WS 下发 `task.create` 给插件 `background.js`。
3. 插件确保目标 tab 的 content/bridge 脚本已注入，注入 `__relayTaskId` 全局变量，并把配置写入主世界 `localStorage.__relayCfg`（供 pageBridge 读取），再以 `world:'MAIN'` 注入 `pageBridge.js`；然后向 content script 发 `task.run`（含 prompt / 选择器 / 是否流式 / chatApi / sseField）。
4. content.js 把 prompt 填入输入框、点击发送；`bridge.js`（隔离世界）与 `pageBridge.js`（主世界）分别尝试拦截流式，逐块回传 `delta`。
5. 后端以 OpenAI SSE 格式把 chunk 透传给客户端；120s 内无完成事件则任务超时失败。
6. 网页回答结束，插件发 `task.done`，后端标记成功并关闭 SSE 流。
7. 兜底：上述拦截通道均失效时，`content.js` 用 `MutationObserver` 监听回答区节点回传新增文本。

---

## 8. 插件 Options 配置（每标签页独立）

| 配置项 | 说明 |
| --- | --- |
| 启用 | 是否监听该标签页并连接网关（关闭则断开该实例） |
| WS URL | 后端地址，如 `ws://127.0.0.1:8191/ws`（公网用 `wss://`） |
| Token | 与后端 `auth_token` 一致 |
| Instance / 路由 Tag | 路由分组键（如 `chatgpt`、`chatgpt-web-3`）。**调用时 `model` 填此值即可路由到该 tag 下实例** |
| 支持的模型 | 该实例声明的模型名列表（逗号分隔，用于 `/v1/models` 展示） |
| 输入框选择器 / 发送按钮选择器 | 网页模型输入框 / 发送按钮的 CSS 或 XPath |
| 对话接口路径 / SSE 字段映射 | bridge / pageBridge 拦截匹配与字段解析（含 `reasoning_content` 思考链支持） |
| 平台预设 | 内置 `openai` / `stepfun` / `claude` 三套选择器与字段映射，一键填入 |

> 每个标签页一套配置、一条独立 WS 连接。新增标签页时从「当前已打开的浏览器标签」中挑选并保存。

---

## 9. 加载与配置插件

1. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 **`extension/`** 目录（不是 `extension - 副本/`）。
3. 点击插件图标 → 「选项」，对每个要使用的标签页：
   - 勾选「启用」
   - Gateway WS URL：`ws://127.0.0.1:8191/ws`（公网用 `wss://`）
   - Access Token：与后端 `auth_token` 一致（默认 `sk-demo-token`）
   - Instance Tag：`chatgpt` / `claude` / `chatgpt-web-3` 等
   - 输入框 / 发送按钮 CSS 选择器（可先用「平台预设」一键填入）
   - 点「保存全部」
4. 打开对应网页版模型并保持登录。
5. 浏览器控制台执行 `chrome.storage.local.get(['targetTabs'])` 确认配置已写入（每个启用标签页 `enabled:true`、正确 `tag`/`models`）。

> 🔁 **每次修改扩展 JS 文件后，必须在 `chrome://extensions` 点「重新加载」(↻) 按钮**，否则浏览器仍在运行旧内存代码，改动不生效。

---

## 10. 两种使用模式

### 10.1 手动模式（Popup 驱动，无需后端）

在插件 Popup 中选择目标标签页 → 输入内容 → 发送 → 插件直接填入网页并捕获流式输出在弹窗内展示。完全本地，不经由 Golang 后端。

Popup 还提供：
- **实例连接状态面板**：实时显示各标签页是否在线、`instance_id`、`tag`；
- **元素探测开关**：开启后在控制台打印点击/输入元素的 CSS 选择器与 XPath，便于配置选择器。

**二次对话说明（已修复）**：手动模式下，`content.js` 维护一个任务上下文 `cur`。第一次对话完成后由 `task.finished` 消息（popup 收到 `task.done`/`task.error` 时下发）清空 `cur`；并设有 120s 超时兜底。因此**连续多次对话都能正常触发选择器发送**，不会被「上一次未清空」拦截。

### 10.2 接口驱动模式（后端 + 插件协同）

```bash
curl -N -H "Authorization: Bearer sk-demo-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt","stream":true,"messages":[{"role":"user","content":"用一句话解释量子纠缠"}]}' \
  http://127.0.0.1:8191/v1/chat/completions
```

后端经 WS 下发任务给插件 → 插件驱动**已配置的目标标签页**的网页 → delta 以 SSE 经 WS 上行 → 后端原样透传 OpenAI SSE。

- 精确路由某标签页：`model` 填 `inst-<前缀>-<tabId>`（从 `/v1/models` 或 Popup 连接状态面板获取）。
- 按 tag 负载均衡：`model` 填 `chatgpt-web-3`（某实例上报的 tag）。

---

## 11. 测试

### 11.1 内置测试网页

启动 `main.exe` 后，浏览器打开 `http://127.0.0.1:8191/`，使用内置「网关对接测试台」：

1. **健康检查**：确认后端存活及**已连接的网页插件实例数**（实例为 0 时对话返回 503）。
2. **模型列表**：拉取在线实例列表（`/v1/models`）。
3. **对话测试**：发一条对话，流式逐字显示 SSE 回传（需插件在线且保持对应网页登录）。
4. **取消任务**：流式进行中调用 `/v1/chat/cancel` 并向插件下发 `task.cancel` 中断网页请求。

页面为自包含单文件（`web/test.html`），连接地址 / 前缀 / Token 可在页面上临时修改，无需重新编译。

### 11.2 模拟插件（无需浏览器）

```powershell
go build -o simws.exe ./cmd/simws
# 先启动 main.exe，再启动 simws.exe，然后 curl 调用即可看到 SSE 透传
```

---

## 12. 内部协议（WebSocket JSON）

实例注册由 **WS 连接 query 参数**自动完成（`?instance_id=&tag=&models=&token=`），无需单独的 `register` 消息。心跳通过前端 `ping` 帧推进 `LastPing`。

```
插件(主世界/隔离) → 后端:
  task.ack     {type, task_id}                          // 任务被插件接收并已在网页执行
  task.delta   {type, task_id, choices, finish_reason}  // 流式增量（bridge 通道）
  task.done    {type, task_id, content, finish_reason}  // 网页回答完成（终态）
  task.error   {type, task_id, message}                 // 执行错误
  task.status  {type, task_id, status, message}         // 状态变更（可选）

后端 → 插件(background.js):
  task.create  {type, task_id, model, messages, stream, temperature}  // 下发任务
  task.cancel  {type, task_id}                              // 取消指令

插件内部（background.js → content.js）:
  task.run       {type, task_id, prompt, inputSelector, sendSelector, chatApi, sseField}
  task.cancel    {type, task_id}
  task.finished  {type, task_id}   // 手动模式对话结束后由 popup 下发，通知 content 清空 cur

页面主世界 → content.js (window.postMessage):
  __pageBridge   {__pageBridge:'delta'|'done', content}   // pageBridge 主世界抓取后回传
```

错误码约定（后端 → 客户端 HTTP）：

| code | 含义 |
|---|---|
| 400 | 请求体解析失败 / 缺 messages |
| 401 | Token 缺失或错误（HTTP Bearer 或 WS `?token=`） |
| 404 | model 未知且无匹配 tag / instance_id |
| 503 | 目标 tag / 实例无在线实例 |
| 504 | 任务超时（120s） |

---

## 13. 可靠性与已知限制

- **断线重连**：`background.js` 采用指数退避（初次 1s，上限 30s）重连；配置存于 `chrome.storage.local`，重连后自动重新注册。
- **instance_id 稳定**：前缀持久化于 storage，service worker 重启后不变化，避免路由 key 抖动。
- **负载均衡**：同 tag 下选择「当前并发任务最少」的实例，任务数相同时轮询（round-robin）。
- **并发控制**：单实例串行执行，后端对实例标记 `busy`，新任务排队或路由到其他实例。
- **已知限制**：
  - 拦截式流式依赖页面 `fetch`，站点强 CSP（`connect-src` 白名单）时会回退到 `MutationObserver` 兜底。
  - 网页改版（选择器 / SSE 结构变化）需同步更新 Options 配置或平台预设。
  - 手动模式下单标签页同一时刻只能处理一个任务（二次对话可顺序触发，已被 `cur` 接管逻辑修复）。

---

## 14. 常见问题排查（Troubleshooting）

### Q1. 派发时报 "A listener indicated an asynchronous response by returning true..."
原因：`onMessage` 监听器 `return true` 声明异步响应却从不调用 `sendResponse`。已修复——所有不需要回响应的分支（task.run / task.cancel / picker.toggle）改为 `return`（不再 `return true`），`selector.test` 等确需响应的保留 `return true + sendResponse`。popup 派发端改用显式回调并忽略"端口关闭"类无害告警。

### Q2. 控制台有 `[pageBridge:xxx]` 打印，但内容没回传到 WS / 弹窗
说明 pageBridge 主世界已抓到数据，但回传链断在中间。检查：
- `pageBridge` 是否被正确注入（`world:'MAIN'`）—— 加载目录必须是 `extension/`；
- `content.js` 是否监听 `__pageBridge` 消息并转发 `task.delta`（已修复）；
- 手动模式下是否有 `cur` 上下文（需先经 `task.run` 启动任务，`cur` 才有 `task_id`）；
- 主世界配置 `localStorage.__relayCfg` 是否含正确的 `chatApi`。

### Q3. 手动模式第二次发不出（点了发送只显示「正在派发」但不操作输入框）
原因：第一次对话后 `cur` 残留，`task.run` 被 `if (cur) return` 拦截（已修复）。现在不同 `task_id` 的新对话可接管，且 `task.finished` + 120s 超时双兜底清理 `cur`。

### Q4. 改完代码不生效
必须在 `chrome://extensions` 点「重新加载」扩展，并确认加载的是 `extension/` 目录。

---

## 15. 安全提示

- 公网部署强制 `wss://` + HTTPS；本机/内网可用 `ws://`。
- 网关 WS 注册强制校验 `token`（与 `auth_token` 一致），非法/伪造实例无法注册，不出现在 `/models`、`/healthz`。
- 网页登录凭据仅存浏览器本地，后端与插件均不上传。
- 仅限个人 / 企业内部自用 / 研究用途。

---

## 16. 阶段规划

| 阶段 | 范围 | 状态 |
|---|---|---|
| 第一阶段 | 手动模式 + 端到端打通（单实例、单标签） | ✅ 已实现 |
| 第二阶段 | 接口驱动 + 多实例聚合 + 负载均衡 + 取消 | ✅ 已实现核心链路 |
| 第三阶段（规划） | 全自动接管：插件监听页面 fetch 自动识别网页模型并注册，免手动绑标签页；可视化实例池管理后台 | ⬜ 待定 |
| 第四阶段（规划） | 思考链（`reasoning_content`）单独 SSE 字段透传标准化；多 tag 并行扇出；失败自动重试路由 | ⬜ 待定 |
