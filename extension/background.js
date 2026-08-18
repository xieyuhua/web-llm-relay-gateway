// background service worker：每个启用的标签页各自维护一条独立的 WebSocket 连接
// 多标签页监听：每个选项卡 = 一个网页 = 一套完整独立配置（含独立网关连接、选择器、字段映射）。
// 来自各自网关的任务，定向派发到对应标签页，互不影响。
//
// 身份匹配：用「归一化网址」作为稳定 key（storage 主键），运行时再 resolve 到浏览器当前真实的 tabId。
// 归一化规则：origin + pathname（去掉 query/hash 等易变参数），这样关掉网页再重新打开（tabId 会变）也能自动重新激活。
// 同 host 下不同会话（如 /c/aaa、/c/bbb）也能靠 pathname 区分。
let cfg = null;
let debugOn = false; // debug 开关：开启后在控制台打印「匹配」「传输」数据
let instanceId = 'inst-' + Math.random().toString(36).slice(2, 10);

// 真实 tabId -> 连接对象 { ws, cfg, attempt, key }
const connections = {};

// Popup 长连接（手动对话回传用）：手动对话任务的回传经此处转发给 popup
let popupPort = null;

function loadCfg() {
  return chrome.storage.local.get(['targetTabs', 'relayDebug']).then((s) => {
    cfg = { targetTabs: s.targetTabs || {} };
    debugOn = !!s.relayDebug;
    return cfg;
  });
}

// ---------- 稳定身份匹配：归一化网址（origin + pathname，去 query/hash） ----------
function normUrl(u) {
  try {
    const p = new URL(u || '');
    if (!/^https?:$/.test(p.protocol)) return (u || '').trim();
    // 去掉 query 与 hash，仅保留 origin + pathname，避免 token/时间戳等易变参数干扰匹配
    return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin;
  } catch {
    return (u || '').trim();
  }
}
// 兼容旧版：旧配置主键可能是「host|标题」格式，提取其中的 host 做兜底匹配
function isOldKey(k) { return (k || '').includes('|'); }
function oldKeyHost(k) { return (k || '').split('|')[0] || ''; }
// 稳定 key -> 当前真实 tabId
//   1) 精确：归一化 URL（origin+pathname）完全一致；
//   2) origin 兜底：key 的 origin 与实际标签 origin 相同即命中（配置通常只填 host 级 URL，
//      如 https://chatgpt.com，而实际打开了具体对话页 /c/abc，此时按 origin 匹配）。
//   3) 旧版 host|标题 主键：提取 host 走 origin 兜底。
async function resolveLiveTabId(key) {
  const all = await chrome.tabs.query({});
  const live = all.filter(t => t.url && /^https?:/.test(t.url));
  // 旧版 host|标题 主键：直接按 host 兜底
  if (isOldKey(key)) {
    const host = oldKeyHost(key);
    const hit = live.find(t => { try { return new URL(t.url).host === host; } catch { return false; } });
    return hit ? hit.id : null;
  }
  const nk = normUrl(key);
  // 精确：origin+pathname 一致
  let hit = live.find(t => normUrl(t.url) === nk);
  if (hit) return hit.id;
  // origin 兜底：key 只写了 host 级 URL（pathname 为空或 '/'），匹配该 origin 下任意页面
  let origin = '';
  try { origin = new URL(key).origin; } catch { return null; }
  hit = live.find(t => { try { return new URL(t.url).origin === origin; } catch { return false; } });
  return hit ? hit.id : null;
}

// 当前启用的标签页配置列表（key 为稳定身份，不再依赖临时 tabId）
function enabledTabConfigs() {
  return Object.entries(cfg.targetTabs || {})
    .filter(([, c]) => c && c.enabled && c.autoConnect !== false)
    .map(([key, c]) => ({ key, c }));
}

// 建立（或重建）单个 tab 的网关连接
async function connectTab(key, c) {
  // 解析当前真实 tabId；页面未打开则不建连（关掉网页再开后由 rebuildAll 自动重连）
  const liveId = await resolveLiveTabId(key);
  if (liveId == null) return;
  const id = liveId;
  const existing = connections[id];
  const cfgKey = JSON.stringify({ u: c.wsUrl || '', t: c.token || '', g: (c.tag || '').trim(), m: (c.models || '') });
  // 存活连接且配置未变：跳过重建，避免 rebuildAll（多标签启用/保存时触发）把健康连接关掉重连导致刷屏
  if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN && existing.cfgKey === cfgKey) return;
  if (existing && existing.ws) { try { existing.ws.close(); } catch {} }

  let url = c.wsUrl || 'ws://127.0.0.1:8191/ws';
  const models = (c.models || 'chatgpt-web').split(',').map((x) => x.trim()).filter(Boolean);
  const tag = c.tag || 'chatgpt';
  url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(c.token || '') +
         '&instance_id=' + encodeURIComponent(instanceId + '-' + id) +
         '&tag=' + encodeURIComponent(tag) +
         '&models=' + encodeURIComponent(models.join(','));

  let attempt = (existing && existing.attempt) || 0;
  const ws = new WebSocket(url);
  connections[id] = { ws, cfg: c, cfgKey, attempt, key };

  ws.onopen = () => {
    const e = connections[id];
    e.attempt = 0;
    e.openedAt = Date.now();
    console.log('[relay] WS connected for tab', id, 'key=', key, 'tag=', tag);
  };
  ws.onmessage = (ev) => {
    let env;
    try { env = JSON.parse(ev.data); } catch { return; }
    handleEnvelope(env, id);
  };
  ws.onclose = () => {
    const e = connections[id];
    // 频繁重连时仅在第 3 次及以上打印，避免关闭/回收期的刷屏噪声
    if (!e || e.attempt >= 3) console.log('[relay] WS closed for tab', id, 'retrying (attempt', (e ? e.attempt : 0), ')...');
    scheduleReconnect(id, key, c);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect(id, key, c) {
  const conn = connections[id];
  const attempt = conn ? conn.attempt : 0;
  // 指数退避 + 随机抖动（避免多标签同刻重连雪崩），封顶 60s
  let delay = Math.min(1000 * Math.pow(2, attempt), 60000);
  delay += Math.floor(Math.random() * 800); // 0~800ms 抖动
  if (conn) conn.attempt = attempt + 1;
  setTimeout(async () => {
    const cur = cfg.targetTabs[key];
    // 页面未打开 / 已停用则停止重连，避免无限重连刷屏
    const liveId = await resolveLiveTabId(key);
    if (liveId == null) return;
    if (cur && cur.enabled && cur.autoConnect !== false) connectTab(key, cur);
  }, delay);
}

// 通过某 tab 的连接发送（若连接断开则忽略，由重连保证）
function sendTo(id, env) {
  const conn = connections[id];
  if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(env));
  }
}

// task_id -> 真实目标页面 tabId（content 注入与上行路由用）
const taskTabs = {};
// task_id -> 网关连接所在 tabId（上行回传用，单标签下等于 taskTabs）
const taskConns = {};
const finishedTasks = new Set();

function handleEnvelope(env, connTabId) {
  switch (env.type) {
    case 'task.create': {
      console.log('[relay] task.create recv task_id=', env.task_id, 'fromConnTab=', connTabId, 'tag=', env.tag);
      sendTo(connTabId, { type: 'task.ack', task_id: env.task_id });
      const tabs = enabledTabConfigs();
      if (tabs.length === 0) {
        sendTo(connTabId, { type: 'task.error', task_id: env.task_id, data: { code: 'NO_TARGET_TAB', message: '未启用任何标签页监听，请在插件 Options 中勾选并配置标签页' } });
        return;
      }
      // 路由优先级：
      //   1) 任务自带 env.tag 且能匹配到某 tab 的 c.tag（多 tab 共用一条 WS 的场景）；
      //   2) 否则用「这条 WS 连接所服务的 tab」本身（每条 tab 配置建一条独立 WS，
      //      连接时已绑定该 tab 的 identity，故指令天然属于它自己对应的页面）。
      const reqTag = (env.tag || '').trim();
      let matched = null;
      if (reqTag) {
        matched = tabs.find(({ c }) => (c.tag || '').trim() === reqTag);
      }
      if (!matched) {
        const connKey = connections[connTabId] && connections[connTabId].key;
        if (connKey) matched = tabs.find(({ key }) => key === connKey);
      }
      const target = matched || tabs[0];
      const key = target.key;
      const tabCfg = target.c;
      console.log('[relay] task.create route -> key=', key, 'tabId=', (() => { try { return resolveLiveTabIdSync(key); } catch { return '?'; } })(), 'byTag=', !!reqTag, 'byConn=', !!(connections[connTabId] && connections[connTabId].key && !reqTag));
      // 解析当前真实 tabId（页面可能关掉重开，tabId 已变）
      resolveLiveTabId(key).then((tabId) => {
        if (tabId == null) {
          sendTo(connTabId, { type: 'task.error', task_id: env.task_id, data: { code: 'TARGET_PAGE_CLOSED', message: '目标页面当前未打开（identity=' + key + '），请打开对应网页' } });
          return;
        }
        // 记录双向映射：task_id -> 目标页面(tabId)、task_id -> 网关连接所在 tab(connTabId)
        taskTabs[env.task_id] = tabId;
        taskConns[env.task_id] = connTabId;

        // 确保接收端 content script 已就绪（插件安装前打开的页面不会自动注入），content.js 有幂等守卫，可重复注入
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (list, field, debug) => { window.__relayChatApi = list; window.__relaySseField = field || ''; window.__relayDebug = !!debug; },
          args: [ (tabCfg.chatApi || '').split(',').map((x) => x.trim()).filter(Boolean), tabCfg.sseField || '', debugOn ],
        }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (tid) => { window.__relayTaskId = tid; },
          args: [env.task_id],
        }).catch(() => {});
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['bridge.js'] }).catch(() => {});
        // 把配置写入【主世界】localStorage.__relayCfg，供 pageBridge.js（主世界）读取共享
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: (chatApi, sseField, logPaths) => {
            try {
              const raw = window.localStorage.getItem('__relayCfg') || '{}';
              const o = JSON.parse(raw);
              if (chatApi) o.chatApi = chatApi;
              if (sseField) o.sseField = sseField;
              if (logPaths) o.logPaths = logPaths;
              window.localStorage.setItem('__relayCfg', JSON.stringify(o));
            } catch (e) {}
          },
          args: [ tabCfg.chatApi || '', tabCfg.sseField || '', tabCfg.logPaths || '' ],
        }).catch(() => {});
        // 注入【主世界】pageBridge.js：hook 页面真实 fetch/XHR/SSE，抓主世界发出的流式响应并回传
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['pageBridge.js'], world: 'MAIN' }).catch(() => {});

        setTimeout(() => {
          const prompt = (env.data.messages || []).map((m) => m.content).join('\n');
          const payload = {
            type: 'task.run',
            task: {
              task_id: env.task_id,
              prompt,
              stream: env.data.stream !== false,
              inputSelector: tabCfg.inputSelector || '',
              sendSelector: tabCfg.sendSelector || '',
              sseField: tabCfg.sseField || '',
            },
          };
          chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
            const list = (frames && frames.length) ? frames : [{ frameId: 0 }];
            for (const f of list) {
              chrome.tabs.sendMessage(tabId, payload, { frameId: f.frameId }).catch(() => {});
            }
          });
        }, 250);
      });
      break;
    }
    case 'task.cancel': {
      const tabId = taskTabs[env.task_id];
      if (tabId != null) {
        chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
          const list = (frames && frames.length) ? frames : [{ frameId: 0 }];
          for (const f of list) {
            chrome.tabs.sendMessage(tabId, { type: 'task.cancel', task_id: env.task_id }, { frameId: f.frameId }).catch(() => {});
          }
        });
        delete taskTabs[env.task_id];
      }
      break;
    }
    case 'ping':
      sendTo(connTabId, { type: 'pong', data: { ts: Date.now() } });
      break;
  }
}

// 标签页被关闭时，清除其在内存中的 task 映射与连接
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const tid in taskTabs) {
    if (taskTabs[tid] === tabId) delete taskTabs[tid];
  }
  for (const tid in taskConns) {
    if (taskConns[tid] === tabId) delete taskConns[tid];
  }
  if (connections[tabId]) { try { connections[tabId].ws.close(); } catch {} delete connections[tabId]; }
});

// 来自 content script / bridge 的上行（task.delta / task.done / task.error）
// 经过 tab 的连接回传给对应网关；手动对话（task_id 以 'manual' 开头）回传给 popup
chrome.runtime.onMessage.addListener((msg) => {
  const isManual = typeof msg.task_id === 'string' && msg.task_id.startsWith('manual');
  // 手动对话回传：转发给 popup 长连接（若 popup 在线）
  if (isManual) {
    const m = (type, data) => { if (popupPort) popupPort.postMessage({ type, task_id: msg.task_id, ...data }); };
    if (msg.type === 'bridge.delta' || msg.type === 'task.delta') {
      if (debugOn) console.log('[relay-bg][传输 delta → popup]', msg.content);
      m('task.delta', { content: msg.content });
    } else if (msg.type === 'bridge.done' || msg.type === 'task.done') {
      if (finishedTasks.has(msg.task_id)) return;
      finishedTasks.add(msg.task_id);
      m('task.done', {});
    } else if (msg.type === 'task.acked') {
      m('task.acked', {});
    } else if (msg.type === 'task.error') {
      if (finishedTasks.has(msg.task_id)) return;
      finishedTasks.add(msg.task_id);
      m('task.error', { code: msg.code, message: msg.message });
    }
    return;
  }
  // 上行回传目标：优先取网关连接所在 tab（taskConns），单标签下与 taskTabs 相同
  const tabId = taskConns[msg.task_id] || taskTabs[msg.task_id] || msg.tabId;
  if (msg.type === 'bridge.delta') {
    if (!msg.task_id) return;
    if (debugOn) console.log('[relay-bg][传输 delta → 网关]', msg.content);
    sendTo(taskConns[msg.task_id] || taskTabs[msg.task_id], { type: 'task.delta', task_id: msg.task_id, data: { format: 'sse', payload: sseChunk(msg.task_id, msg.content) } });
  } else if (msg.type === 'bridge.done') {
    if (!msg.task_id || finishedTasks.has(msg.task_id)) return;
    finishedTasks.add(msg.task_id);
    if (debugOn) console.log('[relay-bg][传输 done → 网关]', msg.task_id);
    sendTo(taskConns[msg.task_id] || taskTabs[msg.task_id], { type: 'task.done', task_id: msg.task_id, data: { finish_reason: 'stop' } });
  } else if (msg.type === 'task.delta') {
    if (debugOn) console.log('[relay-bg][传输 delta → 网关]', msg.content);
    sendTo(tabId, { type: 'task.delta', task_id: msg.task_id, data: { format: 'sse', payload: sseChunk(msg.task_id, msg.content) } });
  } else if (msg.type === 'task.done') {
    if (msg.task_id && finishedTasks.has(msg.task_id)) return;
    if (msg.task_id) finishedTasks.add(msg.task_id);
    if (debugOn) console.log('[relay-bg][传输 done → 网关]', msg.task_id);
    sendTo(tabId, { type: 'task.done', task_id: msg.task_id, data: { finish_reason: 'stop' } });
  } else if (msg.type === 'task.error') {
    if (msg.task_id && finishedTasks.has(msg.task_id)) return;
    if (msg.task_id) finishedTasks.add(msg.task_id);
    sendTo(tabId, { type: 'task.error', task_id: msg.task_id, data: { code: msg.code, message: msg.message } });
  }
});

// Popup 长连接：用于手动对话回传
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => { if (popupPort === port) popupPort = null; });
  }
});

function sseChunk(taskId, chunk) {
  const id = 'chatcmpl-' + taskId;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'relay' };
  // chunk 可为字符串（兼容）或结构化对象 { content, reasoning_content, finish_reason }
  if (chunk && typeof chunk === 'object' && chunk.finish_reason) {
    return 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: chunk.finish_reason }] }) + '\n\n';
  }
  const content = (chunk && typeof chunk === 'object') ? (chunk.content || '') : (chunk || '');
  const reasoning = (chunk && typeof chunk === 'object') ? (chunk.reasoning_content || '') : '';
  const delta = {};
  if (content) delta.content = content;
  if (reasoning) delta.reasoning_content = reasoning;
  return 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta }] }) + '\n\n';
}

// 配置更新：按当前启用的 tab 重建所有连接
async function rebuildAll() {
  await loadCfg();
  const enabled = enabledTabConfigs();
  // 每个启用 key 解析当前真实 tabId
  const liveByKey = {};
  const liveIds = new Set();
  for (const { key } of enabled) {
    const id = await resolveLiveTabId(key);
    liveByKey[key] = id;
    if (id != null) liveIds.add(id);
  }
  // 关闭已停用/已删除 / 页面不存在 的 tab 连接
  for (const id of Object.keys(connections)) {
    if (!liveIds.has(parseInt(id, 10))) {
      try { connections[id].ws.close(); } catch {}
      delete connections[id];
    }
  }
  // 建立 / 刷新启用 tab 的连接（connectTab 内部再 resolve 一次，确保真实 tabId 最新）
  for (const { key, c } of enabled) connectTab(key, c);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'config.updated') rebuildAll();
});

// 元素探测模式开关：由 Options 页触发，转发到所有启用 tab 的全部 frame
// 注意：这里没有 sendResponse 也不需要回应，故不要 return true（否则会触发
// "A listener indicated an asynchronous response..." 告警）。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'picker.toggle') {
    const targets = msg.key != null
      ? [{ key: msg.key, id: null }]
      : enabledTabConfigs();
    (async () => {
      for (const { key } of targets) {
        const id = msg.key != null ? await resolveLiveTabId(msg.key) : (key ? await resolveLiveTabId(key) : null);
        if (id == null) continue;
        chrome.webNavigation.getAllFrames({ tabId: id }, (frames) => {
          const list = (frames && frames.length) ? frames : [{ frameId: 0 }];
          for (const f of list) {
            chrome.tabs.sendMessage(id, { type: 'picker.toggle', on: !!msg.on }, { frameId: f.frameId }).catch(() => {});
          }
        });
      }
    })();
  }
});

rebuildAll();
