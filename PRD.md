# 产品需求文档（PRD）：网页大模型聚合网关 Web LLM Relay Gateway

| 项 | 内容 |
|---|---|
| 文档版本 | v1.1 |
| 状态 | 已实现端到端最小可跑版本（第一阶段 + 第二阶段核心链路） |
| 负责人 | 后端 / 插件开发 |
| 最后更新 | 2026-08-17 |

---

## 1. 背景与问题

当前大量高质量大模型仅以「网页版」形式提供（ChatGPT、Claude、StepFun、Gemini 等），且往往要求账号登录、有人机校验、无公开可用的 API Key。与此同时，各类 Agent 框架、脚本、IDE 插件普遍只认 **OpenAI 兼容的 `/v1/chat/completions` 接口**。

痛点：

1. 想用网页模型驱动自动化工具，必须逆向其私有 API / 抓取 Cookie，维护成本高且易被封。
2. 账号资源分散在多个浏览器标签页 / 多台机器，无法像「模型池」一样统一调度。
3. 直接暴露账号 Cookie 给第三方工具存在隐私与安全风险。

## 2. 产品目标

把「已经登录的网页版大模型」包装成一个**标准 OpenAI 兼容网关**：

- **对外**：任何 OpenAI SDK / curl / Agent 框架，直接以 `Authorization: Bearer <token>` + `/v1/chat/completions` 调用，无需感知底层是网页。
- **对内**：通过自研浏览器插件，在用户已登录的网页上「代操作 + 捕获流式输出」，凭据始终留在浏览器本地，网关与后端均不持有账号密码 / Cookie。
- **可扩展**：多实例按 `tag` 聚合，支持负载均衡，把多台机器上的浏览器变成「模型集群」。

### 2.1 非目标（Out of Scope）

- 不提供账号托管 / Cookie 代管服务。
- 不做模型微调、RAG、向量库等模型能力增强（仅做透传）。
- 不逆向或破解任何站点接口；所有站点适配通过用户手动配置完成。

## 3. 用户与场景

| 角色 | 场景 |
|---|---|
| 个人开发者 | 本地起网关，用 ChatGPT 网页账号喂给本地 Agent / 自写脚本，免去申请 API Key。 |
| 企业内部 | 几台机器各自登录企业版模型网页，统一经网关对内提供 OpenAI 接口，集中供多个内部工具调用。 |
| 研究者 | 快速对比同一 prompt 在不同网页模型上的流式表现，通过 `tag` 切换路由。 |

## 4. 总体方案

三层架构：

```
OpenAI 客户端 (SDK/curl/Agent)
        │  OpenAI Chat Completions (SSE)
        ▼
Golang 后端 (main.exe)  ─── WebSocket (内部 JSON 协议) ──▶  浏览器插件 (MV3)
        │                                                  │ 注入 prompt / 点发送
        │                                                  ▼
        │                                          网页版模型 (已登录)
        ◀──────────── OpenAI SSE 透传 (经 WS 上行 chunk) ───┘
```

- **后端**：HTTP 暴露 OpenAI 接口；WebSocket 管理插件实例；任务状态机；按 `tag` 路由 + 负载均衡；SSE 透传。
- **插件**：WS 客户端 + 任务编排；content script 操控 DOM；双世界流式拦截（隔离世界 `bridge.js` + 主世界 `pageBridge.js`）；兜底 MutationObserver；指数退避重连。
- **网页模型**：被操控的执行引擎，对网关透明。

> **双世界说明**：MV3 的 content script 运行在「隔离世界」，重写 `window.fetch` 抓不到页面主世界发出的请求。因此对部分站点需额外把 `pageBridge.js` 以 `world:'MAIN'` 注入主世界，直接 hook 页面真实的 `fetch` / `XMLHttpRequest` / `EventSource`。两条通道互补，覆盖绝大多数站点。

## 5. 功能需求

### FR-1 标准 OpenAI 兼容接口

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/v1/chat/completions` | POST | 是 | 核心对话，支持 `stream=true/false` |
| `/v1/models` | GET | 是 | 返回在线实例列表（每个在线实例一条，ID=instance_id；同 tag 多实例时额外追加 tag 聚合入口） |
| `/healthz` | GET | 否 | 健康检查，返回在线实例数与实例明细 |
| `/v1/chat/cancel` | POST | 是 | 取消进行中任务，body `{"task_id":"..."}` |
| `/` 或 `/test` | GET | 否 | 内置对接自检测试台 |
| `/ws` | GET(WS) | 是 | 插件注册通道（`?token=` 必填，与 `config.yaml` 的 `auth_token` 一致），query 带 `instance_id`/`tag`/`models` 自动注册 |

- 请求体严格对齐 OpenAI schema（`model` / `messages` / `stream` / `temperature` 等透传）。
- 流式响应逐块透传 `choices[].delta.content`；非流式在 `response` 收齐后返回完整 `choices[].message.content`。

### FR-2 多实例聚合与路由

- 每个插件实例连接时自动注册，携带 `instance_id`（形如 `inst-<前缀>-<tabId>`，前缀按浏览器 profile 持久化）、`tag`、`models`。
- 请求 `model` 的路由优先级：
  1. **精确 instance_id**：等于某在线实例的 `instance_id` → 路由到该**具体标签页**（按实例精确选择）。
  2. **tag 名**：等于某在线实例上报的 `tag`（如 `chatgpt` / `chatgpt-web-3`）→ 在该 tag 在线实例中按「当前并发任务数最少 + 轮询」负载均衡。
  3. **配置 model / `auto`**：回退到 `config.yaml` 的 `models` 声明；`auto` 在全部在线实例中择优。
- ⚠️ `tag` 不做首段截断：`chatgpt-web-3` 即完整 tag，调用 `model: "chatgpt-web-3"` 直接命中上报了该 tag 的实例。
- `tag` / 精确 id 下无在线实例 → 返回 `503`，message 提示「无可用实例」。

### FR-3 任务生命周期管理

- 每轮对话生成 `task_id`，状态机：`pending → running → done / error / timeout / cancelled`。
- 超时：120s 内未收到 `done` 则标记 `timeout` 并以 SSE error 结束。
- 取消：客户端调 `/v1/chat/cancel` → 后端向实例下发 `task.cancel` → 插件侧 `AbortController.abort()` 中断页面请求。
- **手动模式任务上下文清理（实现补充）**：手动对话由 Popup 驱动，content.js 维护任务上下文 `cur`。一次对话完成后，Popup 收到 `task.done`/`task.error` 时下发 `task.finished` 消息通知 content.js 清空 `cur`；并设 120s 超时兜底，确保 `cur` 不会永久残留。不同 `task_id` 的新对话可直接接管（避免「上一次未清空导致二次对话被拦截」）。

### FR-4 网页流式捕获（双通道 + 兜底）

- **隔离世界通道（bridge.js）**：注入 content script 隔离世界，拦截聊天 `fetch` 流式响应，按 Options 配置的「SSE 字段映射」解析 `delta.content` / `delta.reasoning_content` / `finish_reason` / `done`，逐块经 `chrome.runtime.sendMessage({type:'bridge.delta'/'bridge.done'})` 回传。
- **主世界通道（pageBridge.js）**：以 `world:'MAIN'` 注入页面主世界，直接 hook 页面真实的 `fetch` / `XMLHttpRequest` / `EventSource`（三路之一），抓取隔离世界看不到的请求；抓到后 `window.postMessage({__pageBridge:'delta'/'done', content})` 发给 content.js，再由 content 经 `task.delta`/`task.done` 回传。配置通过主世界 `localStorage.__relayCfg` 共享。
- **兜底（观察式）**：当站点 CSP 禁止 fetch 拦截且主世界 hook 也未命中时，`content.js` 用 `MutationObserver` 监听回答区节点，按「差异选择器」回传新增文本。
- 三种通道对后端协议统一为 `task.delta` / `task.done` 消息，后端不感知差异。命中任一即可回传，互不冲突。

### FR-5 插件配置（Options）

用户手动填写，保证「网页无关」：

- 连接：`WS URL`、`Token`、`Tag`。
- DOM 选择器：输入框、发送按钮、回答区。
- 适配参数：对话接口路径后缀、SSE 字段映射（含 `reasoning_content` 支持思考链模型）。
- **平台预设**：内置 `openai` / `stepfun` / `claude` 三套选择器 + 字段映射，一键填入；其余站点手动配置。

### FR-6 运行模式

- **手动模式（Popup，无需后端）**：在弹窗内选择目标标签页 → 输入 → 发送 → 插件本地捕获流式展示（弹窗内）。提供「实例连接状态」面板与「元素探测」开关。
- **接口驱动模式（后端 + 插件）**：经网关统一调度，支持多实例并发。

### FR-7 可靠性

- 断线指数退避重连（1s 起，上限 30s），`tag` 等配置持久化于 `chrome.storage.local`，重连后自动重新注册。
- 单实例串行执行，后端标记 `busy` 避免任务叠加。
- 主世界 / 隔离世界双通道互补，提升不同站点、不同 CSP 策略下的流式捕获成功率。

## 6. 内部协议（WebSocket JSON）

实例注册由 **WS 连接 query 参数**自动完成（`?instance_id=&tag=&models=&token=`），无需单独的 `register` 消息。心跳通过前端 `ping` 帧推进 `LastPing`。

```
插件(隔离/主世界) → 后端:
  task.ack     {type, task_id}                          // 任务被插件接收并已在网页执行
  task.delta   {type, task_id, choices, finish_reason}  // 流式增量（choices[].delta.content / reasoning_content）
  task.done    {type, task_id, content, finish_reason}  // 网页回答完成（终态）
  task.error   {type, task_id, message}                 // 执行错误（如 NO_TARGET_TAB / 目标标签未配置 / 网页未登录）
  task.status  {type, task_id, status, message}         // 状态变更（可选）

后端 → 插件(background.js):
  task.create  {type, task_id, model, messages, stream, temperature}  // 下发任务（含完整对话参数）
  task.cancel  {type, task_id}                              // 取消指令（插件侧 AbortController.abort）

插件内部（background.js → content.js）:
  task.run       {type, task_id, prompt, inputSelector, sendSelector, chatApi, sseField}  // 注入 prompt + 选择器，驱动网页
  task.cancel    {type, task_id}                           // 中断页面请求
  task.finished  {type, task_id}                           // 手动对话结束后由 popup 下发，通知 content 清空 cur

页面主世界 → content.js (window.postMessage):
  __pageBridge   {__pageBridge:'delta'|'done', content}   // pageBridge 主世界抓取后回传，content 转 task.delta/task.done
```

错误码约定（后端 → 客户端 HTTP）：

| code | 含义 |
|---|---|
| 400 | 请求体解析失败 / 缺 messages |
| 401 | Token 缺失或错误（HTTP Bearer 或 WS `?token=`） |
| 404 | model 未知且无匹配 tag / instance_id |
| 503 | 目标 tag / 实例无在线实例 |
| 504 | 任务超时（120s） |

插件侧 `task.error` 业务码（常见，供前端展示）：

| code | 含义 |
|---|---|
| NO_TARGET_TAB | 未启用任何标签页监听，请在 Options 勾选并配置 |
| TARGET_PAGE_CLOSED | 目标页面当前未打开（host 不匹配） |
| NO_INPUT | 输入框选择器未匹配到元素，请在 Options 正确配置 |
| SET_TEXT_FAILED | 写入输入框失败（元素不可编辑 / 被遮挡） |
| USER_CANCELLED | 任务被取消 |

## 7. 非功能性需求

- **安全**：公网强制 `wss://` + HTTPS；Token 仅用于网关鉴权，不接触网页账号；凭据永不上传。
- **合规**：仅限个人 / 企业自用 / 研究用途；用户自行承担对目标站点的使用条款风险。
- **可观测**：`/healthz` 暴露在线实例数；后端日志打印任务创建 / 路由 / 完成 / 超时。
- **可移植**：后端单二进制（embed 测试页），Windows / Linux 均可运行；插件 MV3 标准加载。

## 8. 阶段规划

| 阶段 | 范围 | 状态 |
|---|---|---|
| 第一阶段 | 手动模式 + 端到端打通（单实例、单标签） | ✅ 已实现 |
| 第二阶段 | 接口驱动 + 多实例聚合 + 负载均衡 + 取消 | ✅ 已实现核心链路 |
| 第二阶段补强 | 主世界 `pageBridge.js`（world:MAIN）流式 hook + 双世界回传互补 + 手动模式二次对话 `cur` 清理与超时兜底 | ✅ 已实现 |
| 第三阶段（规划） | 全自动接管：插件监听页面 fetch 自动识别网页模型并注册，免手动绑标签页；可视化实例池管理后台 | ⬜ 待定 |
| 第四阶段（规划） | 思考链（`reasoning_content`）单独 SSE 字段透传标准化；多 tag 并行扇出；失败自动重试路由 | ⬜ 待定 |

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 网页 DOM / 接口改版 | 选择器或 SSE 结构失效 | Options 手动改配置 / 更新平台预设；代码不写死 |
| 站点强 CSP 阻断 fetch 拦截 | 无法精确流式 + 无法取消 | 主世界 `pageBridge` 兜底 hook + MutationObserver 观察式兜底（已内置） |
| 账号风控 / 人机校验 | 插件操作被拦截 | 人工保持登录；单实例串行降低频率；不自动化突破校验 |
| 多实例状态不一致 | 路由到已离线实例 | `/healthz` 心跳 + 注册/注销 + 路由前校验在线 |
| 凭据泄露 | 账号风险 | 凭据仅存浏览器本地；网关不存储；Token 与账号体系隔离 |

## 10. 验收标准（v1.1）

1. 启动 `main.exe` 与一个插件实例后，`/healthz` 返回在线实例数 ≥ 1。
2. `curl` 调 `/v1/chat/completions`（`stream=true`）能逐字收到 OpenAI SSE，内容来自网页模型。
3. 同一 `tag` 下起两个实例，连续请求按「最少并发 + 轮询」分布到不同实例。
4. 流式过程中调 `/v1/chat/cancel`，插件侧 `AbortController` 中断页面请求，后端 SSE 流正常关闭。
5. 关闭插件标签页 / 断网后，实例从 `/healthz` 在线数移除；重连后自动恢复注册。
6. 对主世界发起请求的站点，经 `pageBridge.js`（world:MAIN）也能成功抓取流式并回传（控制台可见 `[pageBridge:fetch/xhr/eventsource]` 来源标签）。
7. 手动模式连续发起多次对话，每次都能正常触发选择器输入与发送，无「二次对话被拦截」。
