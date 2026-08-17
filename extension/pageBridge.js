// pageBridge.js —— 注入到【页面主世界】(world: MAIN)，接管页面真正的 fetch / XMLHttpRequest / EventSource
// 为什么需要它：MV3 content script 跑在隔离世界，重写 window.fetch 抓不到页面主世界发出的请求。
// 本脚本必须在主世界运行，才能 hook 到 studio.stepfun.com 真实发出的流式请求。
// 抓到的数据通过 window.postMessage({__pageBridge:...}) 发给 content script（隔离世界），再由其回传 background。
(function () {
  if (window.__pageBridgeInstalled) return;
  window.__pageBridgeInstalled = true;

  // 读取配置：优先 localStorage（content.js 持久化写入，消除消息竞态），其次 postMessage 兜底
  let userPaths = null;
  let logPaths = null;
  let sseRule = null; // SSE 字段提取规则（JSON 对象）
  function readStoredCfg() {
    try {
      const raw = window.localStorage.getItem('__relayCfg');
      if (raw) {
        const o = JSON.parse(raw);
        if (o.chatApi) userPaths = o.chatApi.split(',').map((x) => x.trim()).filter(Boolean);
        if (o.logPaths) logPaths = o.logPaths.split(',').map((x) => x.trim()).filter(Boolean);
        if (o.sseField) {
          try { sseRule = JSON.parse(o.sseField); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  readStoredCfg();
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.__pageBridgeCfg !== true) return;
    if (e.data.chatApi) userPaths = e.data.chatApi.split(',').map((x) => x.trim()).filter(Boolean);
    if (e.data.logPaths) logPaths = e.data.logPaths.split(',').map((x) => x.trim()).filter(Boolean);
    if (e.data.sseField) { try { sseRule = JSON.parse(e.data.sseField); } catch (err) {} }
  });

  function getPaths() {
    const list = (window.__relayChatApi && window.__relayChatApi.length) ? window.__relayChatApi
      : (userPaths || []);
    return list;
  }
  function getLogPaths() { return window.__relayLogPaths || logPaths || []; }

  function looksLikeChat(url, init) {
    const paths = getPaths();
    const urlNoQuery = String(url).split(/[?#]/)[0];
    const hasUser = paths.length > 0;
    if (paths.some((p) => String(url).includes(p) || urlNoQuery.includes(p))) {
      if (hasUser) return paths.some((p) => String(url).includes(p) || urlNoQuery.includes(p));
      return true;
    }
    // 未配置 chatApi 时的默认特征匹配（兜底）
    if (!hasUser) {
      const defaults = ['/chat/completions', '/v1/messages', '/api/chat', '/studio/stream'];
      if (defaults.some((p) => String(url).includes(p))) {
        if (!init || !init.body) {
          // studio 流式接口即使无 body 特征，路径命中即作为兜底（避免漏抓）
          return true;
        }
        try {
          const b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          if (b && (b.stream === true || (b.messages && Array.isArray(b.messages)) || b.conversation_id || (b.kind === 'chat'))) return true;
        } catch (e) {}
      }
    }
    return false;
  }

  function shouldLogTraffic(url) {
    const logs = getLogPaths();
    if (!logs.length) return false;
    const urlNoQuery = String(url).split(/[?#]/)[0];
    return logs.some((p) => String(url).includes(p) || urlNoQuery.includes(p));
  }

  // 按点路径取值：支持对象属性与数组索引，如 "choices.0.delta.content"、"data.delta"
  function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    const parts = String(path).split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  // 判断 obj 是否满足 when 条件（单层键值相等匹配）
  function matchWhen(obj, when) {
    if (!when || typeof when !== 'object') return true;
    return Object.keys(when).every((k) => obj[k] === when[k]);
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
  // 按映射表把网页字段组装成标准结构对象；返回 { out, text }
  function applyMap(obj, fields) {
    const out = {};
    let text = '';
    (fields || []).forEach((f) => {
      const std = f.std || f.standard;
      const src = f.src || f.source;
      if (!std || !src) return;
      const v = getByPath(obj, src);
      if (v == null) return;
      setByPath(out, std, v);
      if (/content$/.test(std) || std === 'content') text = String(v);
    });
    return { out, text };
  }

  // 通用提取：按用户配置的 sseField 规则从一条 SSE data 载荷取出要回传的文本
  function extractContent(payload) {
    if (!payload || payload === '[DONE]') return '';
    // raw 模式：非 JSON 纯文本直接回传
    if (sseRule && sseRule.type === 'raw') {
      return /^\[?DONE\]?$/.test(payload) ? '' : payload;
    }
    let obj = null;
    try { obj = JSON.parse(payload); } catch (e) { obj = null; }
    if (!obj) {
      // 非 JSON：若规则为 jsonpath 则回退原样，否则原样
      return /^\[?DONE\]?$/.test(payload) ? '' : payload;
    }
    // 若配置了 when 条件且不满足，跳过（不回传）
    if (sseRule && sseRule.when && !matchWhen(obj, sseRule.when)) return '';

    if (sseRule && sseRule.type === 'map' && Array.isArray(sseRule.fields)) {
      const { text } = applyMap(obj, sseRule.fields);
      return text || '';
    }
    if (sseRule && sseRule.type === 'jsonpath' && sseRule.path) {
      const v = getByPath(obj, sseRule.path);
      if (v != null) return String(v);
      return ''; // 有规则但路径取不到，返回空（不回退噪音）
    }
    // 未配置规则时的兜底：尝试常见字段
    const ch = obj.choices && obj.choices[0];
    if (ch) {
      if (ch.delta && ch.delta.content != null) return String(ch.delta.content);
      if (ch.message && ch.message.content != null) return String(ch.message.content);
      if (ch.text != null) return String(ch.text);
    }
    if (obj.content != null) return String(obj.content);
    if (obj.type === 'text_delta' && obj.data && obj.data.delta != null) return String(obj.data.delta);
    if (obj.delta != null) return String(obj.delta);
    if (obj.data && typeof obj.data === 'object') {
      if (obj.data.delta != null) return String(obj.data.delta);
      if (obj.data.content != null) return String(obj.data.content);
      if (obj.data.text != null) return String(obj.data.text);
    }
    return '';
  }

  function handleSseData(payload, source) {
    if (!payload || payload === '[DONE]') return;
    const content = extractContent(payload);
    if (content) {
      // 仅打印成功提取到的纯文本数据；source 标注来自 fetch / xhr / eventsource，便于排查
      console.log('[pageBridge:' + (source || '?') + ']', content);
    }
    post('delta', content || payload);
  }

  function post(kind, content) {
    window.postMessage({ __pageBridge: kind, content }, '*');
  }

  // ---------- 接管 fetch ----------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isChat = looksLikeChat(url, init);
    const logIt = shouldLogTraffic(url);
    if (!isChat && !logIt) return origFetch.apply(this, arguments);

    return origFetch.call(this, input, init).then((resp) => {
      if (!resp.body) {
        if (isChat) post('done', '');
        return resp;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const stream = new ReadableStream({
        start(controller) {
          function pump() {
            return reader.read().then(({ value, done }) => {
              if (done) {
                if (isChat) post('done', '');
                controller.close();
                return;
              }
              const text = decoder.decode(value, { stream: true });
              text.split('\n').forEach((line) => {
                if (!line.startsWith('data:')) return;
                handleSseData(line.slice(5).trim(), 'fetch');
              });
              controller.enqueue(value);
              return pump();
            });
          }
          return pump();
        },
      });
      return new Response(stream, { headers: resp.headers, status: resp.status, statusText: resp.statusText });
    });
  };

  // ---------- 接管 XMLHttpRequest ----------
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__pbUrl = String(u || '');
    this.__pbMethod = m || 'GET';
    return OrigOpen.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__pbUrl || '';
    const isChat = looksLikeChat(url, { body });
    const logIt = shouldLogTraffic(url);
    if (!isChat && !logIt) return OrigSend.call(this, body);
    let lastLen = 0;
    const self = this;
    const pump = () => {
      try {
        if (self.readyState >= 3 && typeof self.responseText === 'string') {
          const full = self.responseText;
          if (full.length > lastLen) {
            const inc = full.slice(lastLen);
            lastLen = full.length;
            if (isChat) inc.split('\n').forEach((l) => { if (l.startsWith('data:')) handleSseData(l.slice(5).trim(), 'xhr'); });
          }
        }
      } catch (e) {}
    };
    this.addEventListener('readystatechange', pump);
    this.addEventListener('progress', pump);
    this.addEventListener('readystatechange', () => {
      if (self.readyState === 4 && isChat) post('done', '');
    });
    return OrigSend.call(this, body);
  };

  // ---------- 接管 EventSource ----------
  const OrigES = window.EventSource;
  if (OrigES) {
    function RelayES(url, opts) {
      const es = new OrigES(url, opts);
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      const isChat = looksLikeChat(u, null);
      es.addEventListener('message', (ev) => {
        const data = ev && ev.data;
        if (data == null) return;
        if (isChat) String(data).split('\n').forEach((l) => { if (l.startsWith('data:')) handleSseData(l.slice(5).trim(), 'eventsource'); if (!String(data).includes('data:')) handleSseData(String(data).trim(), 'eventsource'); });
      });
      return es;
    }
    RelayES.prototype = OrigES.prototype;
    Object.getOwnPropertyNames(OrigES).forEach((k) => { if (k !== 'prototype' && k !== 'length' && k !== 'name') { try { RelayES[k] = OrigES[k]; } catch (e) {} } });
    window.EventSource = RelayES;
  }
})();
