// content.js —— 运行于被监听网页主世界（及所有 frame）
// 接收 background 定向下发的 task.run（含该标签页专属的 inputSelector/sendSelector/sseField），
// 在对应网页内执行输入、发送、抓取回答并回传。
//
// 选择器定位层（resolve）支持：
//   1) 原生 CSS 选择器，含任意组合/伪类/属性选择器，例如：
//        body > div.group\/sidebar-wrapper.flex... > main > div > div > main > div > div > div > textarea
//        #search-bar > div > div > p
//   2) XPath，自动识别（以 // (// /html /.// 开头），例如：
//        //*[@id="search-bar"]/div/div/p
// 解析失败时给出可读的诊断信息，而非笼统的「未找到」。
(function () {
    if (window.__relayInjected) return; // 幂等：避免重复注入
    window.__relayInjected = true;

    console.log('[relay-content] injected');

    // 读取 debug 开关（与 pickMode 一致，从 storage 同步，popup 关闭后仍可用）
    try {
        chrome.storage.local.get(['relayDebug'], (o) => { window.__relayDebug = !!o.relayDebug; });
    } catch (e) { window.__relayDebug = !!window.__relayDebug; }

    // 把对话接口 / 流量 / SSE 配置持久化到 localStorage.__relayCfg，
    // 供【主世界】运行的 pageBridge.js 读取（隔离世界无法直接共享 window 变量给主世界）。
    function persistCfgForPageBridge(over) {
        try {
            const raw = window.localStorage.getItem('__relayCfg') || '{}';
            const o = JSON.parse(raw);
            Object.assign(o, over || {});
            window.localStorage.setItem('__relayCfg', JSON.stringify(o));
        } catch (e) { }
    }
    try {
        chrome.storage.local.get(['chatApi', 'logPaths', 'sseField'], (s) => {
            const o = {};
            if (s.chatApi) o.chatApi = s.chatApi;
            if (s.logPaths) o.logPaths = s.logPaths;
            if (s.sseField) o.sseField = s.sseField;
            persistCfgForPageBridge(o);
        });
    } catch (e) { }

    // 当前任务上下文（由 background 随 task.run 下发，按标签页独立）
    let cur = null; // { task_id, prompt, stream, inputSelector, sendSelector, sseField }

    function reportDelta(text) {
        if (!cur) return;
        chrome.runtime.sendMessage({ type: 'task.delta', task_id: cur.task_id, content: text });
    }
    function reportDone() {
        if (!cur) return;
        chrome.runtime.sendMessage({ type: 'task.done', task_id: cur.task_id });
        cur = null;
    }
    function reportError(code, msg) {
        if (!cur) return;
        chrome.runtime.sendMessage({ type: 'task.error', task_id: cur.task_id, code, message: msg });
        cur = null;
    }

    // ---------- 选择器解析层 ----------
    function isXPath(sel) {
        return /^\s*(\/\/|\(\/\/|\/html|\.\/\/)/.test(sel);
    }

    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0;
    }

    // 返回 { node, all, error }
    function resolve(sel, wantFirst) {
        if (!sel || !sel.trim()) return { error: '选择器为空' };
        let nodes = [];
        try {
            if (isXPath(sel)) {
                const res = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < res.snapshotLength; i++) nodes.push(res.snapshotItem(i));
            } else {
                nodes = Array.from(document.querySelectorAll(sel));
            }
        } catch (e) {
            return { error: '选择器语法错误: ' + e.message };
        }
        nodes = nodes.filter(Boolean);
        if (nodes.length === 0) {
            return { error: '页面上无匹配元素（selector=' + sel + '）' };
        }
        // 优先返回「可见」的；全不可见则返回第一个
        const vis = nodes.filter(visible);
        const chosen = wantFirst ? (vis[0] || nodes[0]) : nodes;
        return { node: vis[0] || nodes[0], all: nodes, visibleCount: vis.length, error: null };
    }

    function setText(el, value) {
        el.focus();
        el.scrollIntoView({ block: 'center' });
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
            : (el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : null);
        if (proto) {
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, value);
        } else {
            el.textContent = value; // contenteditable 等
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isClickable(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') <= 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        return true;
    }

    // 对单元素做真实鼠标点击（兼容 React/Vue 合成事件）
    function realMouseClick(el) {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const opts = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
    }

    function clickSend(btn) {
        if (!btn) return false;
        if (!isClickable(btn)) {
            // 试着再等一会儿（站点的发送按钮可能在输入后才可用）
            return 'disabled';
        }
        btn.scrollIntoView({ block: 'center' });

        const tag = (btn.tagName || '').toUpperCase();

        if (tag === 'A') {
            // <a> 作为发送按钮：可能是 React 合成事件挂在 <a> 或其子节点上
            const href = btn.getAttribute('href');
            const hasRealHref = href && href.trim() !== '' && href.trim() !== '#' && !href.trim().startsWith('javascript:');
            // 1) 先尝试对 <a> 自身做真实鼠标点击（合成事件最可靠）
            realMouseClick(btn);
            // 2) 若 <a> 自身无真实 href（纯按钮式 <a>），再对其内部首个可点元素补一发，避免事件挂在子节点
            if (!hasRealHref) {
                const inner = btn.querySelector('a,button,[role="button"],div,span,svg');
                if (inner) realMouseClick(inner);
            }
            // 3) 兜底：原生 click（对真实链接会触发导航，但多数发送 <a> 已 preventDefault）
            try { btn.click(); } catch (e) { }
            return true;
        }

        // button / input / 其他：真实鼠标点击 + 原生 click 兜底
        realMouseClick(btn);
        try { btn.click(); } catch (e) { }
        return true;
    }

    // 等待直到回调返回 true，或超时（避免死等）。返回 true 表示条件满足。
    function waitUntil(cond, timeoutMs, intervalMs) {
        return new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
                let ok = false;
                try { ok = cond(); } catch (e) { ok = false; }
                if (ok) return resolve(true);
                if (Date.now() - start >= timeoutMs) return resolve(false);
                setTimeout(tick, intervalMs);
            };
            tick();
        });
    }

    // ---------- 阶段一：写入输入框并「确认完成」 ----------
    // 返回 true 表示输入已成功写入；false 表示失败（已上报错误）。
    async function fillInput() {
        let r = resolve(cur.inputSelector, true);
        if (r.error) {
            if (window === window.top) {
                reportError('NO_INPUT', r.error + '，请在 Options 中为该标签页正确配置输入框选择器');
            }
            cur = null;
            return false;
        }
        const input = r.node;
        try {
            setText(input, cur.prompt);
        } catch (e) {
            reportError('SET_TEXT_FAILED', '写入输入框失败: ' + e.message);
            return false;
        }
        // 等待输入框内容真正落定（部分站点用 React 受控组件，需等其 state 同步），
        // 同时确认元素未被卸载。最多等 3s，避免阻塞。
        await waitUntil(() => {
            const cur2 = resolve(cur.inputSelector, true);
            if (!cur2.node) return false;
            const v = cur2.node.value;
            if (typeof v === 'string') return v === cur.prompt || v.length >= cur.prompt.length;
            return cur2.node.textContent === cur.prompt || (cur2.node.textContent || '').includes(cur.prompt);
        }, 3000, 100);
        return true;
    }

    // ---------- 阶段二：发送（必须在输入框写入完成后才执行） ----------
    async function doSend() {
        const input = resolve(cur.inputSelector, true).node;
        // 发送：优先用 sendSelector；否则回车提交
        if (cur.sendSelector) {
            // 先等待发送按钮变得可点（站点常需输入框内容就绪后才启用/渲染发送按钮）
            const ready = await waitUntil(() => {
                const sr = resolve(cur.sendSelector, false);
                if (sr.error || !sr.all.length) return false;
                return !!sr.all.find(isClickable);
            }, 5000, 150);
            const sr = resolve(cur.sendSelector, false);
            if (!sr.error && sr.all.length) {
                let btn = sr.all.find(isClickable) || sr.all[0];
                const res = clickSend(btn);
                if (res === 'disabled') {
                    // 仍不可用：再补等一轮后重试（站点的发送按钮可能在输入后才可用）
                    await waitUntil(() => {
                        const sr2 = resolve(cur.sendSelector, false);
                        return !!(sr2.all && sr2.all.find(isClickable));
                    }, 8000, 200).then(() => {
                        if (!cur) return;
                        const sr2 = resolve(cur.sendSelector, false);
                        if (sr2.all && sr2.all.length) {
                            const b = sr2.all.find(isClickable);
                            if (b) clickSend(b);
                        }
                    });
                }
                return;
            }
            // sendSelector 未命中（即使等待后仍未出现）：回车提交兜底
            if (input) submitInput(input);
        } else {
            if (input) submitInput(input);
            else submitInput(resolve(cur.inputSelector, true).node);
        }
    }

    async function runTask() {
        // 本 frame 未匹配到输入框：若自己是顶层 frame 则报错（多半是选择器配错）；
        // 若是子 frame 则静默忽略（输入框可能在别的 frame 中），避免重复误报。
        // 阶段一：写入输入框，并等待其生效
        const ok = await fillInput();
        if (!ok) return; // fillInput 内部已上报错误 / 静默忽略
        // 输入与发送之间固定间隔 1 秒，确保输入框内容被站点充分处理/识别
        await new Promise((res) => setTimeout(res, 2000));
        // 阶段二：输入框写入已完成后，再处理发送选择器（确保顺序执行）
        await doSend();
    }

    function submitInput(input) {
        const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        input.dispatchEvent(ev);
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        if (input.form && typeof input.form.requestSubmit === 'function') {
            try { input.form.requestSubmit(); } catch { }
        }
    }

    function cleanup() {
        if (cur && cur._finishTimer) { try { clearTimeout(cur._finishTimer); } catch (e) { } }
        cur = null;
    }

    // ---------- 选择器实时测试（供 Options 页配置时即时验证） ----------
    function selfTest(sel, wantFirst) {
        const r = resolve(sel, wantFirst);
        let firstTag = null;
        if (r.node) {
            const n = r.node;
            firstTag = n.tagName ? n.tagName.toLowerCase() : '';
            if (n.id) firstTag += '#' + n.id;
            else if (n.className && typeof n.className === 'string') {
                const c = n.className.trim().split(/\s+/)[0];
                if (c) firstTag += '.' + c;
            }
        }
        return {
            href: location.href,
            isTop: window === window.top,
            count: r.all ? r.all.length : 0,
            visibleCount: r.visibleCount || 0,
            firstTag,
            error: r.error || null,
        };
    }

    // 接收来自父 frame 的跨 frame 测试请求
    window.addEventListener('message', (e) => {
        if (!e.data || !e.data.__relayTest) return;
        try { parent.postMessage({ __relayTestResult: selfTest(e.data.selector, e.data.wantFirst) }, '*'); } catch (err) { }
    });

    // 接收来自【主世界】pageBridge.js 抓到的对话数据：经 background 回传 WS/网关
    // pageBridge 运行在主世界，抓到流式内容后 window.postMessage({ __pageBridge: 'delta'|'done', content })
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.__pageBridge == null) return;
        const kind = e.data.__pageBridge;
        const content = e.data.content;
        if (kind === 'delta') {
            if (!cur) return; // 仅在有 WS 任务上下文时回传（避免手动模式误发）
            chrome.runtime.sendMessage({ type: 'task.delta', task_id: cur.task_id, content: content });
        } else if (kind === 'done') {
            if (!cur) return;
            chrome.runtime.sendMessage({ type: 'task.done', task_id: cur.task_id });
        }
    });

    // 监听来自 background 的指令
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'relay.debug') {
            window.__relayDebug = !!msg.on;
            return;
        }
        if (msg.type === 'selector.test') {
            if (window !== window.top) return false; // 仅顶层 frame 负责汇总（子 frame 已由上面 message 监听处理）
            const results = [selfTest(msg.selector, msg.wantFirst)];
            const frames = Array.from(window.frames);
            const pending = frames.length;
            if (pending === 0) { sendResponse({ ok: true, results }); return true; }
            let done = 0;
            const finish = () => sendResponse({ ok: true, results });
            const to = setTimeout(finish, 700);
            const onResp = (e) => {
                if (!e.data || !e.data.__relayTestResult) return;
                results.push(e.data.__relayTestResult);
                if (++done === pending) { clearTimeout(to); window.removeEventListener('message', onResp); finish(); }
            };
            window.addEventListener('message', onResp);
            frames.forEach((f) => {
                try { f.postMessage({ __relayTest: true, selector: msg.selector, wantFirst: msg.wantFirst }, '*'); }
                catch (err) { if (++done === pending) { clearTimeout(to); window.removeEventListener('message', onResp); finish(); } }
            });
            return true; // 异步响应
        }
        if (msg.type === 'task.run') {
            const t = msg.task;
            // 仅当同一 task_id 已在执行时才忽略（防止同一次广播的多 frame 重复执行）。
            // 若是不同 task_id（上一次对话已结束但上下文未清空），则允许新对话接管，
            // 否则 cur 残留会导致二次对话被拦截、无法触发选择器发送。
            if (cur && cur.task_id === t.task_id) return;
            cur = {
                task_id: t.task_id,
                prompt: t.prompt,
                stream: t.stream !== false,
                inputSelector: t.inputSelector || '',
                sendSelector: t.sendSelector || '',
                sseField: t.sseField || '',
            };
            // 立即向 popup/网关确认已收到并即将执行（diagnostic，证明派发链路通）
            try { chrome.runtime.sendMessage({ type: 'task.acked', task_id: cur.task_id }); } catch (e) { }
            // 保险：若对话长时间未回传 done/error（如接口未返回结束符），超时自动清空 cur，
            // 避免 cur 永久残留导致后续对话被 if(cur) return 拦截
            if (cur._finishTimer) clearTimeout(cur._finishTimer);
            cur._finishTimer = setTimeout(() => { if (cur && cur.task_id === t.task_id) cleanup(); }, 120000);
            runTask();
            return; // 不需要回响应，避免消息通道提前关闭告警
        }
        if (msg.type === 'task.cancel') {
            if (cur && cur.task_id === msg.task_id) {
                cleanup();
                reportError('USER_CANCELLED', 'task cancelled by user');
            }
            return; // 不需要回响应
        }
        if (msg.type === 'task.finished') {
            // 手动对话结束（done/error）后由 popup 发来，清空任务上下文，
            // 使二次对话能重新进入 task.run（否则 if(cur) return 会拦截）
            if (cur && cur.task_id === msg.task_id) cleanup();
            return; // 不需要回响应
        }
        if (msg.type === 'picker.toggle') {
            window.__relayPickMode = !!msg.on;
            console.log('[relay-picker] ' + (window.__relayPickMode ? '已开启：点击页面元素将打印其选择器' : '已关闭'));
            return; // 不需要回响应
        }
    });

    // ---------- 元素探测模式（独立功能：点击任意元素 → 控制台打印其 CSS/XPath） ----------
    // 由 window.__relayPickMode 控制；true 时开启，阻止默认行为并输出选择器。
    function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + cssEscape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 8) {
            let seg = cur.tagName.toLowerCase();
            if (cur.classList && cur.classList.length) {
                const cls = Array.from(cur.classList).slice(0, 2).map(cssEscape).join('.');
                if (cls) seg += '.' + cls;
            }
            if (cur.parentNode) {
                const same = Array.from(cur.parentNode.children).filter((c) => c.tagName === cur.tagName);
                if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
            }
            parts.unshift(seg);
            cur = cur.parentNode;
            if (cur && cur.nodeType === 1 && cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
        }
        return parts.join(' > ');
    }
    function xpathOf(el) {
        if (!el || el.nodeType !== 1) return '';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1) {
            let idx = 1;
            let sib = cur.previousElementSibling;
            while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
            let seg = cur.tagName.toLowerCase();
            const sameTagSibs = Array.from(cur.parentNode ? cur.parentNode.children : []).filter((c) => c.tagName === cur.tagName);
            if (sameTagSibs.length > 1) seg += '[' + idx + ']';
            parts.unshift(seg);
            cur = cur.parentNode;
            if (cur && cur.nodeType === 1 && cur.id) { parts.unshift('//*[@id="' + cur.id + '"]'); break; }
        }
        return '/' + parts.join('/');
    }
    function cssEscape(s) { return (s || '').replace(/([^\w-])/g, '\\$1'); }

    function onPickClick(e) {
        if (!window.__relayPickMode) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const el = e.target;
        const css = cssPath(el);
        const xp = xpathOf(el);
        const tag = el.tagName ? el.tagName.toLowerCase() : '?';
        console.log('%c[relay-picker] 点击元素', 'color:#0a0;font-weight:bold');
        console.log('  tag      :', tag);
        console.log('  CSS      :', css);
        console.log('  XPath    :', xp);
        console.log('  复制用 ↓');
        console.log('  ' + css);
        console.log('  outerHTML:', el.outerHTML ? el.outerHTML.slice(0, 200) : '(n/a)');
    }
    function onPickInput(e) {
        if (!window.__relayPickMode) return;
        const el = e.target;
        const css = cssPath(el);
        const xp = xpathOf(el);
        const tag = el.tagName ? el.tagName.toLowerCase() : '?';
        const val = (el.value !== undefined && el.value !== null) ? el.value
            : (el.textContent !== undefined ? el.textContent : '');
        console.log('%c[relay-picker] 输入事件 (' + e.type + ')', 'color:#06c;font-weight:bold');
        console.log('  tag      :', tag);
        console.log('  CSS      :', css);
        console.log('  XPath    :', xp);
        console.log('  value    :', val);
        console.log('  复制用 ↓');
        console.log('  ' + css);
    }
    document.addEventListener('click', onPickClick, true);   // 捕获阶段，先于页面逻辑
    document.addEventListener('input', onPickInput, true);
    document.addEventListener('change', onPickInput, true);

    // 初始状态：优先用内存值，否则读取 storage（popup 关闭后重新打开插件也能恢复）
    try {
        chrome.storage.local.get(['pickMode'], (o) => { window.__relayPickMode = !!o.pickMode; });
    } catch (e) { window.__relayPickMode = !!window.__relayPickMode; }

})();
