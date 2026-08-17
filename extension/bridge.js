// bridge.js —— 注入网页页面上下文，拦截对话接口流式响应并 postMessage 回 content script
// 用法：content script 通过 chrome.scripting.executeScript 注入本文件。
(function () {
  if (window.__relayBridgeInstalled) return;
  window.__relayBridgeInstalled = true;

  // 对话接口匹配规则：优先用注入时传入的 window.__relayChatApi（用户按自己网页手动配置），
  // 否则回退到默认（适配 ChatGPT / Claude）。回写回答直接命中接口，不依赖 DOM 选择器。
  // 自动注入场景下，content_script 启动时从 chrome.storage.local 读取 chatApi 配置写入 window.__relayChatApi，
  // 使「在网页里手动对话」也能命中用户配置的路径（无需 executeScript 注入）。
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get(['chatApi', 'logPaths'], (s) => {
        const list = (s && s.chatApi ? s.chatApi : '')
          .split(',').map((x) => x.trim()).filter(Boolean);
        if (list.length) window.__relayChatApi = list;
        const logs = (s && s.logPaths ? s.logPaths : '')
          .split(',').map((x) => x.trim()).filter(Boolean);
        if (logs.length) window.__relayLogPaths = logs;
      });
    } catch (e) {}
  }
  // 注意：每次请求都动态读取 window.__relayChatApi（而非加载时固化），避免注入顺序导致配置丢失。
  // 严格按用户配置的对话接口路径匹配：未配置则不兜底（不抓默认路径）。
  function getChatPaths() {
    if (window.__relayChatApi && window.__relayChatApi.length) return window.__relayChatApi;
    return [];
  }
  // debug 开关：开启后在控制台打印「匹配」与「传输」数据，便于排查配置是否生效
  // 自行从 storage 同步一次，确保手动对话/WS 对话均按真实开关生效（不依赖注入方传入的值）
  try {
    chrome.storage.local.get(['relayDebug'], (o) => { window.__relayDebug = !!o.relayDebug; });
  } catch (e) {}

  function getDebug() { return !!window.__relayDebug; }

  // 当前对话请求的 AbortController，用于取消网页请求
  let currentController = null;

  // 上报回传：
  // - 有 task_id（任务/WS 模式）：经 chrome.runtime.sendMessage 直发 background（跨 iframe 可靠）。
  // - 无 task_id（手动模式）：经 window.postMessage 给本 frame 的 content.js，由其经 manualPort 回传 popup。
  // content 可为字符串或结构化对象 { content, reasoning_content, finish_reason }
  function report(kind, content) {
    const taskId = window.__relayTaskId || '';
    if (taskId) {
      try {
        chrome.runtime.sendMessage({ type: 'bridge.' + kind, task_id: taskId, content });
      } catch (e) {}
    } else {
      // 手动模式：通知本 frame content.js（接口通道已工作 + delta 内容）
      const payload = content == null ? '' : (typeof content === 'string' ? content : JSON.stringify(content));
      window.postMessage({ __relay: kind, content: payload }, '*');
    }
  }

  // 逐块回传结构化结果：{ content, reasoning_content, finish_reason }
  function postChunk(r) {
    const chunk = { content: r.content || '', reasoning_content: r.reasoning_content || '', finish_reason: r.finish_reason || '' };
    if (getDebug()) console.log('[relay-bridge][传输 delta]', JSON.stringify(chunk));
    // 通知本 frame 的 content.js：接口通道已回传数据
    window.postMessage({ __relay: 'delta', content: JSON.stringify(chunk) }, '*');
    report('delta', chunk);
  }

  function postDone() {
    if (getDebug()) console.log('[relay-bridge][传输 done]');
    window.postMessage({ __relay: 'done' }, '*');
    report('done', '');
  }

  // 读取可配置的 SSE 数据提取规则（与 options/popup 共享）
  function getSseRule() {
    try {
      let raw = window.__relaySseField;
      if (!raw) {
        const cfg = JSON.parse(localStorage.getItem('__relayCfg') || '{}');
        raw = cfg.sseField;
      }
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (r && typeof r === 'object') return r;
    } catch (e) {}
    return null;
  }
  function getByPath(obj, path) {
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = obj;
    for (const p of parts) {
      if (p === '') continue;
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }
  function matchWhen(obj, when) {
    if (!when || typeof when !== 'object') return true;
    return Object.keys(when).every((k) => obj[k] === when[k]);
  }
  // 按映射表把网页字段组装成标准结构对象；返回结构化 { content, reasoning_content, finish_reason, done }
  function applyMap(obj, fields) {
    const out = { content: '', reasoning_content: '', finish_reason: '', done: false };
    (fields || []).forEach((f) => {
      const std = f.std || f.standard;
      const src = f.src || f.source;
      if (!std || !src) return;
      const v = getByPath(obj, src);
      if (v == null) return;
      setByPath(out, std, v);
      // 按标准字段名归类（std 使用 OpenAI 路径式命名）
      if (std === 'choices.0.delta.content' || std === 'content' || /delta\.content$/.test(std)) {
        out.content = String(v);
      } else if (std === 'choices.0.delta.reasoning_content' || /reasoning_content$/.test(std) || /delta\.reasoning$/.test(std)) {
        out.reasoning_content = String(v);
      } else if (std === 'choices.0.finish_reason' || /finish_reason$/.test(std) || std === 'finish_reason') {
        out.finish_reason = String(v);
      }
    });
    return out;
  }
  function setByPath(obj, path, val) {
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '') continue;
      if (i === parts.length - 1) { cur[p] = val; }
      else { if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
    }
  }

  // 从单条 SSE data 载荷中抽取结构化结果：{ content, reasoning_content, finish_reason, done }
  // - 配置了 sseField 规则时按规则提取（map / jsonpath / raw / when）
  // - 未配置时回退到常见字段兼容
  function extractContent(payload) {
    const empty = { content: '', reasoning_content: '', finish_reason: '', done: false };
    if (!payload) return empty;
    if (payload === '[DONE]') return { content: '', reasoning_content: '', finish_reason: '', done: true };
    const rule = getSseRule();
    if (rule && rule.type === 'raw') {
      return /^[\[]?DONE[\]]?$/.test(payload) ? { ...empty, done: true } : { ...empty, content: payload };
    }
    let obj = null;
    try { obj = JSON.parse(payload); } catch (e) { obj = null; }
    if (!obj) {
      return /^[\[]?DONE[\]]?$/.test(payload) ? { ...empty, done: true } : { ...empty, content: payload };
    }
    // 顶层 done 信号（部分平台用 "done": true 或空 choices）
    if (obj.done === true) return { ...empty, done: true };
    if (rule && rule.when && !matchWhen(obj, rule.when)) return empty;
    if (rule && rule.type === 'map' && Array.isArray(rule.fields)) {
      const out = applyMap(obj, rule.fields);
      const fr = getByPath(obj, 'choices.0.finish_reason');
      if (fr != null) out.finish_reason = String(fr);
      if (out.content || out.reasoning_content || out.finish_reason) return out;
      // 配置了规则但本块无内容（如角色/ID 块）按 done 信号判定：无 delta 则忽略
      if (!obj.choices || !obj.choices[0] || (!obj.choices[0].delta && obj.choices[0].finish_reason == null)) return empty;
      return out;
    }
    if (rule && rule.type === 'jsonpath' && rule.path) {
      const v = getByPath(obj, rule.path);
      return v != null ? { ...empty, content: String(v) } : empty;
    }
    // 兜底：常见字段
    const choice = obj.choices && obj.choices[0];
    const out = { ...empty };
    if (choice) {
      if (choice.delta) {
        if (choice.delta.content != null) out.content = String(choice.delta.content);
        if (choice.delta.reasoning_content != null) out.reasoning_content = String(choice.delta.reasoning_content);
      }
      if (choice.finish_reason != null) out.finish_reason = String(choice.finish_reason);
      if (choice.message && choice.message.content != null) out.content = String(choice.message.content);
      if (choice.text != null) out.content = String(choice.text);
    }
    if (!out.content && !out.reasoning_content && obj.content != null) out.content = String(obj.content);
    if (!out.content && !out.reasoning_content && obj.delta && obj.delta.content != null) out.content = String(obj.delta.content);
    if (!out.content && !out.reasoning_content && obj.message && obj.message.content != null) out.content = String(obj.message.content);
    if (typeof obj.text === 'string') out.content = obj.text;
    if (!out.content && !out.reasoning_content && obj.choices && obj.choices[0] && obj.choices[0].content != null) out.content = String(obj.choices[0].content);
    return out;
  }

  // 处理一条 SSE data 载荷：按配置规则解析出结构化结果，逐块回传
  function handleSseData(payload) {
    if (!payload) return;
    if (payload === '[DONE]') { postDone(); return; }
    const r = extractContent(payload);
    if (r.done) { postDone(); return; }
    if (r.content || r.reasoning_content || r.finish_reason) {
      postChunk(r);
    } else if (getDebug()) {
      console.log('[relay-bridge][回传] 该 chunk 非对话返回内容，已忽略:', payload.slice(0, 200));
    }
  }

  // 判断某个请求是否像「对话接口」
  // 严格按用户配置的对话接口路径（chatApi）匹配，不做任何兜底：
  //   - 用户未配置 chatApi → 不抓取；
  //   - 用户已配置 → 仅当 URL 命中配置路径时算对话接口。
  // 去掉了原来的「默认路径 + 请求体对话特征」兜底，避免误命中或漏命中。
  function looksLikeChat(url, init) {
    const userPaths = (window.__relayChatApi && window.__relayChatApi.length) ? window.__relayChatApi : null;
    if (!userPaths) return false; // 未配置对话接口路径，不兜底抓取
    const urlNoQuery = url.split(/[?#]/)[0];
    return userPaths.some((p) => url.includes(p) || urlNoQuery.includes(p));
  }

  // 判断某个地址是否需要「完整流量打印」（独立于 chatApi 回传，用于抓包排查）
  function shouldLogTraffic(url) {
    const logs = window.__relayLogPaths;
    if (!logs || !logs.length) return false;
    const urlNoQuery = url.split(/[?#]/)[0];
    return logs.some((p) => url.includes(p) || urlNoQuery.includes(p));
  }

  // 把 Headers / 对象安全地转成可打印对象
  function headersToObj(h) {
    const o = {};
    if (h && typeof h.forEach === 'function') {
      h.forEach((v, k) => { o[k] = v; });
    } else if (h && typeof h === 'object') {
      Object.keys(h).forEach((k) => { o[k] = h[k]; });
    }
    return o;
  }

  // 打印一次请求的基础流量信息（method / url / headers / body）
  function logTraffic(url, init, _resp) {
    const headers = headersToObj(init && init.headers);
    let body = init && init.body;
    if (body && typeof body !== 'string') {
      try { body = '(非字符串body, 类型=' + (body.constructor && body.constructor.name) + ')'; } catch (e) { body = '(body不可序列化)'; }
    }
    console.log('[relay-bridge][流量] 请求:', (init && init.method) || 'GET', url);
    console.log('[relay-bridge][流量] 请求头:', JSON.stringify(headers));
    if (body) console.log('[relay-bridge][流量] 请求体:', typeof body === 'string' ? body : String(body));
  }

  // 监听来自 content script 的取消指令
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__relayCancel && currentController) {
      currentController.abort();
      currentController = null;
      window.postMessage({ __relay: 'cancelled' }, '*');
    }
  });

  // 包装 fetch，捕获流式 SSE chunk
  const origFetch = window.fetch;
  let loggedPaths = false; // 仅首次打印一次当前生效的匹配规则，便于排查配置是否生效
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const userPaths = (window.__relayChatApi && window.__relayChatApi.length) ? window.__relayChatApi : null;
    if (!loggedPaths) {
      loggedPaths = true;
      console.log('[relay-bridge] 当前生效 chatApi 路径:', JSON.stringify(userPaths || '(未配置,走默认+请求体特征)'));
      console.log('[relay-bridge] 当前生效 logPaths(流量打印地址):', JSON.stringify(window.__relayLogPaths || '(未配置)'));
    }
    const isChat = looksLikeChat(url, init);
    if (getDebug()) {
      if (isChat) console.log('[relay-bridge][匹配] 命中对话接口:', url, '| 规则:', userPaths ? JSON.stringify(userPaths) : '(未配置)');
      else console.log('[relay-bridge][匹配] 未命中:', url);
    }
    if (!isChat) {
      // 未命中对话接口，但命中流量打印地址时也抓包打印
      if (shouldLogTraffic(url)) logTraffic(url, init, null);
      return origFetch.apply(this, arguments);
    }

    // 对话请求使用 AbortController，支持取消
    const controller = new AbortController();
    currentController = controller;
    const mergedInit = Object.assign({}, init, { signal: controller.signal });

    // 命中流量打印（含对话接口）时，打印请求信息
    if (shouldLogTraffic(url)) logTraffic(url, init, null);

    return origFetch.call(this, input, mergedInit).then((resp) => {
      currentController = null;
      // 打印响应元数据，确认是否为 SSE event stream
      console.log('[relay-bridge] 响应状态:', resp.status, 'content-type:', resp.headers.get('content-type'));
      if (shouldLogTraffic(url)) {
        const h = headersToObj(resp.headers);
        console.log('[relay-bridge][流量] 响应头:', JSON.stringify(h));
      }
      if (!resp.body) {
        if (shouldLogTraffic(url)) {
          resp.clone().text().then((t) => console.log('[relay-bridge][流量] 响应体:', t)).catch(() => {});
        }
        postDone(); return resp;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = ''; // 跨 chunk 累积，按 SSE 事件边界（空行）解析，支持多行 data 合并
      const stream = new ReadableStream({
        start(controller2) {
          function flushEvents() {
            let idx;
            while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
              const rawEvent = sseBuf.slice(0, idx);
              sseBuf = sseBuf.slice(idx + 2);
              // 一个 SSE 事件内可能有多行 data:（OpenAI 规范用 \n 续行），合并为完整载荷
              const dataLines = rawEvent.split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim());
              if (!dataLines.length) continue;
              handleSseData(dataLines.join('\n'));
            }
          }
          function pump() {
            return reader.read().then(({ done, value }) => {
              if (done) {
                if (sseBuf.trim()) flushEvents(); // 收尾：最后一个事件可能无尾随空行
                controller2.close(); postDone(); return;
              }
              const text = decoder.decode(value, { stream: true });
              if (shouldLogTraffic(url)) {
                console.log('[relay-bridge][流量] 响应原始块:', JSON.stringify(text));
              }
              sseBuf += text;
              flushEvents();
              controller2.enqueue(value);
            });
          }
          return pump();
        },
      });
      return new Response(stream, { headers: resp.headers, status: resp.status, statusText: resp.statusText });
    }).catch((err) => {
      currentController = null;
      // 取消也会走到这里，交由 content script 处理
      throw err;
    });
  };

  // EventSource 兜底拦截：部分站点用 new EventSource(url) 走原生 text/event-stream 长连接，
  // 这种请求不经过 fetch，上面 fetch hook 抓不到，这里单独 hook EventSource 构造函数。
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    function RelayEventSource(url, opts) {
      // 允许被 new 调用或普通函数调用，均返回一个真实 EventSource 实例
      const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
      const es = new OrigEventSource(url, opts);
      const isChat = looksLikeChat(urlStr, null);
      if (isChat) {
        console.log('[relay-bridge] 命中 EventSource 对话接口:', urlStr);
      }
      if (isChat || shouldLogTraffic(urlStr)) {
        if (!isChat) console.log('[relay-bridge][流量] 命中 EventSource 打印地址:', urlStr);
        console.log('[relay-bridge][流量] EventSource 请求:', urlStr);
        const onMsg = (ev) => {
          const data = ev && ev.data;
          if (data == null) return;
          if (shouldLogTraffic(urlStr)) {
            console.log('[relay-bridge][流量] EventSource 原始消息:', typeof data === 'string' ? data : String(data));
          }
          // EventSource 多条 data 以 \n 连接，逐行处理
          String(data).split('\n').forEach((line) => {
            if (!line.startsWith('data:')) return; // 原生 event-source 数据通常无 data: 前缀，直接整段处理
            handleSseData(line.slice(5).trim());
          });
          // 没有 data: 前缀的裸 JSON / 文本，直接处理整段
          if (!String(data).includes('data:')) handleSseData(String(data).trim());
        };
        es.addEventListener('message', onMsg);
        // 兜底 onmessage 赋值场景
        const origOnMessage = es;
        Object.defineProperty(es, 'onmessage', {
          configurable: true,
          set(fn) {
            if (typeof fn === 'function') {
              es.addEventListener('message', (ev) => fn(ev));
            }
          },
          get() { return origOnMessage._onmessage || null; },
        });
      }
      return es;
    }
    RelayEventSource.prototype = OrigEventSource.prototype;
    // 复制静态属性（CONNECTING/OPEN/CLOSE 等）
    Object.getOwnPropertyNames(OrigEventSource).forEach((k) => {
      if (k !== 'prototype' && k !== 'length' && k !== 'name') {
        try { RelayEventSource[k] = OrigEventSource[k]; } catch (e) {}
      }
    });
    RelayEventSource.CONNECTING = OrigEventSource.CONNECTING;
    RelayEventSource.OPEN = OrigEventSource.OPEN;
    RelayEventSource.CLOSED = OrigEventSource.CLOSED;
    window.EventSource = RelayEventSource;
  }

  // XMLHttpRequest 兜底拦截：部分站点用 XHR 流式（responseType='stream'/'moz-chunked-*'
  // 或普通 text 累积 responseText），fetch hook 抓不到，这里单独 hook XHR。
  const OrigXHROpen = XMLHttpRequest.prototype.open;
  const OrigXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__relayUrl = String(url || '');
    this.__relayMethod = method || 'GET';
    return OrigXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__relayUrl || '';
    const isChat = looksLikeChat(url, { body });
    const logIt = shouldLogTraffic(url);
    if (!isChat && !logIt) return OrigXHRSend.call(this, body);
    if (isChat) console.log('[relay-bridge] 命中 XHR 对话接口:', url);
    if (logIt) {
      console.log('[relay-bridge][流量] XHR 请求:', this.__relayMethod, url);
      console.log('[relay-bridge][流量] XHR 请求体:', typeof body === 'string' ? body : String(body));
    }
    let lastLen = 0;
    const self = this;
    const origState = this.onreadystatechange;
    const pump = () => {
      try {
        if (self.readyState >= 3 && typeof self.responseText === 'string') {
          const full = self.responseText;
          if (full.length > lastLen) {
            const inc = full.slice(lastLen);
            lastLen = full.length;
            if (logIt) console.log('[relay-bridge][流量] XHR 响应原始块:', JSON.stringify(inc));
            if (isChat) {
              inc.split('\n').forEach((line) => {
                if (!line.startsWith('data:')) return;
                handleSseData(line.slice(5).trim());
              });
            }
          }
        }
      } catch (e) {}
    };
    this.addEventListener('readystatechange', pump);
    this.addEventListener('progress', pump);
    // 响应头在 readyState=2 可读
    this.addEventListener('readystatechange', function () {
      if (self.readyState === 2 && logIt) {
        try {
          const h = {};
          self.getAllResponseHeaders().split('\r\n').forEach((l) => {
            const i = l.indexOf(':');
            if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim();
          });
          console.log('[relay-bridge][流量] XHR 响应状态:', self.status);
          console.log('[relay-bridge][流量] XHR 响应头:', JSON.stringify(h));
        } catch (e) {}
      }
      if (self.readyState === 4 && isChat) postDone();
    });
    return OrigXHRSend.call(this, body);
  };

  // 接收来自 options/popup 的开关变更，立即生效（无需刷新页面或重新注入）
  // - relay.debug：切换调试日志开关（window.__relayDebug）
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'relay.debug') {
        window.__relayDebug = !!msg.on;
        console.log('[relay-bridge] debug', msg.on ? '已开启' : '已关闭');
      }
    });
  } catch (e) {}

  console.log('[relay-bridge] installed, intercepting chat fetch + EventSource + XHR with abort support');
})();
