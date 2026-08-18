// Popup：轻量手动对话（配置统一在 options 网关插件配置页）
// 身份匹配：用「归一化网址」作为稳定 key（origin + pathname，去 query/hash），运行时解析到真实 tabId。
// 关掉网页再重新打开（tabId 会变）也能自动重新匹配，不再误判「已关闭」。
const $ = (id) => document.getElementById(id);

// ---------- 稳定身份 key：归一化网址 ----------
function normUrl(u) {
  try {
    const p = new URL(u || '');
    if (!/^https?:$/.test(p.protocol)) return (u || '').trim();
    return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin;
  } catch {
    return (u || '').trim();
  }
}
function keyOf(tab) { return normUrl(tab.url); }
function isOldKey(k) { return (k || '').includes('|'); }
function oldKeyHost(k) { return (k || '').split('|')[0] || ''; }
// 稳定 key -> 当前真实 tabId（按归一化 URL 匹配；精确失败按 origin 兜底；旧版 host|标题 主键按 host 兜底）
async function resolveLiveTabId(key) {
  const all = await chrome.tabs.query({});
  const live = all.filter(t => t.url && /^https?:/.test(t.url));
  if (isOldKey(key)) {
    const host = oldKeyHost(key);
    const hit = live.find(t => { try { return new URL(t.url).host === host; } catch { return false; } });
    return hit ? hit.id : null;
  }
  const nk = normUrl(key);
  let hit = live.find(t => normUrl(t.url) === nk);
  if (hit) return hit.id;
  let origin = '';
  try { origin = new URL(key).origin; } catch { return null; }
  hit = live.find(t => { try { return new URL(t.url).origin === origin; } catch { return false; } });
  return hit ? hit.id : null;
}

// 跟随 options 中设置的主题
(async () => {
  const o = await chrome.storage.local.get('relayTheme');
  const t = ['dark', 'light', 'cyber'].includes(o.relayTheme) ? o.relayTheme : 'dark';
  document.body.dataset.theme = t;
})();

// 填充目标标签页下拉：列出在 Options 中已启用（并配置了监听）的标签页
async function refreshTabs() {
  const sel = $('targetTabId');
  const s = await chrome.storage.local.get(['targetTabs', 'manualTabId']);
  const tabs = s.targetTabs || {};
  sel.innerHTML = '<option value="">— 请先在扩展设置中启用并配置标签页 —</option>';
  const enabled = Object.entries(tabs).filter(([, c]) => c && c.enabled);
  if (enabled.length === 0) return;
  // 构建稳定 key -> 当前真实 tabId 映射，判断页面是否打开
  const liveMap = {};
  const all = await chrome.tabs.query({});
  for (const t of all) {
    if (!t.url || !/^https?:/.test(t.url)) continue;
    const k = keyOf(t);
    if (!liveMap[k]) liveMap[k] = t.id;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeKey = active ? keyOf(active) : null;
  // 默认选中优先级：用户上次显式选的（manualTabId，且页面仍打开且启用）> 当前活动页（若已启用）> 第一个启用
  let defKey = (s.manualTabId && tabs[s.manualTabId] && tabs[s.manualTabId].enabled && liveMap[s.manualTabId])
    ? s.manualTabId
    : ((activeKey && tabs[activeKey] && tabs[activeKey].enabled) ? activeKey : enabled[0][0]);
  enabled.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const [id, c] of enabled) {
    const opt = document.createElement('option');
    opt.value = id; // 稳定 key（归一化 URL）
    const dead = !liveMap[id]; // 按归一化 URL 在打开的标签中匹配不到 => 页面未打开
    const auto = (id === defKey) ? ' ◀默认' : ((activeKey === id) ? ' ◀当前' : '');
    opt.textContent = `${id.slice(0, 48)}${dead ? '（页面未打开）' : ''}${auto}`;
    if (dead) opt.disabled = true; // 页面未打开的标签不可选，避免误发
    if (id === defKey) opt.selected = true;
    sel.appendChild(opt);
  }
}

// 自动匹配手动对话的标签页（手动切换优先于自动匹配）：
//   1) 用户在下拉里显式选中的标签（若页面打开且启用）→ 用它；
//   2) 否则「当前活动标签页」（若已启用）打开 → 用它；
//   3) 否则第一个启用的且打开的标签；
//   4) 兜底：当前窗口活动页（即便未启用，也保证能注入对话）。
async function autoMatchTab() {
  const s = await chrome.storage.local.get(['targetTabs']);
  const tabs = s.targetTabs || {};
  const enabled = Object.entries(tabs).filter(([, c]) => c && c.enabled);
  // 1) 下拉里用户显式选中的（手动切换优先）：用稳定 key 解析真实 tabId
  const selRaw = $('targetTabId').value || '';
  if (selRaw && tabs[selRaw] && tabs[selRaw].enabled) {
    const id = await resolveLiveTabId(selRaw);
    if (id != null) return id;
  }
  if (enabled.length === 0) {
    const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
    return a ? a.id : null;
  }
  const live = await chrome.tabs.query({});
  const liveKeys = new Set(live.filter(t => t.url && /^https?:/.test(t.url)).map(keyOf));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 2) 当前活动页（若已启用且打开）
  if (active) {
    const ak = keyOf(active);
    if (tabs[ak] && tabs[ak].enabled && liveKeys.has(ak)) return active.id;
  }
  // 3) 第一个启用的且打开
  for (const [id] of enabled) {
    if (liveKeys.has(id)) { const rid = await resolveLiveTabId(id); if (rid != null) return rid; }
  }
  // 4) 兜底当前窗口活动页（一定可注入）
  if (active) return active.id;
  return null;
}

// 发送：向自动匹配的已启用标签页的 content script 发消息并监听流式回传
// 回传统一经 background 中转：手动对话（task_id 以 'manual' 开头）由 background 转发给 popup 长连接。
async function sendMsg() {
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  const s = await chrome.storage.local.get(['targetTabs']);
  const tabId = await autoMatchTab();
  if (!tabId) { $('output').textContent = '[错误] 请先在扩展设置启用并配置一个标签页（也支持直接在该网页上点发送）'; return; }
  // 注入前二次校验：标签可能在此期间被关闭
  const alive = await new Promise((res) => chrome.tabs.get(tabId, (t) => res(!chrome.runtime.lastError && !!t)));
  if (!alive) {
    $('output').textContent = '[错误] 目标标签页已关闭，请刷新该页面或重新打开标签页后再试';
    return;
  }
  const selKey = $('targetTabId').value || '';
  const cfg = (s.targetTabs || {})[selKey] || {};
  const taskId = 'manual-' + Date.now();
  await chrome.storage.local.set({ manualTabId: selKey }); // 存稳定 key，而非临时 tabId
  $('targetTabId').value = selKey; // 让用户看到当前会发往哪里
  $('output').textContent = '';
  if (!cfg.inputSelector) {
    $('output').textContent = '[提示] 该标签页未配置输入框选择器，将自动尝试定位页面输入框；若未能正确输入，请到 Options 用元素探测复制选择器\n';
  }
  // 确保接收端 content script 已就绪（插件安装前打开的页面不会自动注入），content.js 监听器幂等
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    $('output').textContent = '[错误] 无法向该页面注入脚本，请刷新目标标签页，或确认它不是 chrome:// / 扩展页等受限页面：' + (e && e.message || e);
    return;
  }
  const chatApi = (cfg.chatApi || '').split(',').map((x) => x.trim()).filter(Boolean);
  const sseField = cfg.sseField || '';
  const debugOn = !!((await chrome.storage.local.get('relayDebug')).relayDebug);
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (list, rule, debug) => { window.__relayChatApi = list; window.__relaySseField = rule || ''; window.__relayDebug = !!debug; },
    args: [chatApi, sseField, debugOn],
  }).catch(() => {});
  // 写入手动对话 task_id，使 bridge.js 接口通道回传也带 task_id（经 background 转发给 popup）
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (tid) => { window.__relayTaskId = tid; },
    args: [taskId],
  }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['bridge.js'] }).catch(() => {});
  // 把配置写入【主世界】localStorage.__relayCfg，供 pageBridge.js（主世界）读取共享
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (chatApi, sseField) => {
      try {
        const raw = window.localStorage.getItem('__relayCfg') || '{}';
        const o = JSON.parse(raw);
        if (chatApi && chatApi.length) o.chatApi = chatApi.join(',');
        if (sseField) o.sseField = sseField;
        window.localStorage.setItem('__relayCfg', JSON.stringify(o));
      } catch (e) {}
    },
    args: [chatApi, sseField],
  }).catch(() => {});
  // 注入【主世界】pageBridge.js：hook 页面真实 fetch/XHR/SSE，抓主世界发出的流式响应
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['pageBridge.js'], world: 'MAIN' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 250));

  // 与 background 建立 popup 长连接，用于接收手动对话回传
  const port = chrome.runtime.connect({ name: 'popup' });
  let acked = false;
  port.onMessage.addListener((msg) => {
    if (msg.task_id !== taskId) return;
    if (msg.type === 'task.acked') { acked = true; $('output').textContent += '\n[已送达页面，正在执行…]'; }
    else if (msg.type === 'task.delta') {
      const d = msg.content || {};
      const txt = (typeof d === 'string') ? d : ((d.content || '') + (d.reasoning_content || ''));
      $('output').textContent += txt;
    }
    else if (msg.type === 'task.done') {
      $('output').textContent += '\n[完成]';
      // 通知页面 content script 本次手动对话已结束，清空任务上下文，
      // 否则 content.js 的 cur 一直非空，导致二次对话被 if(cur) return 拦截无法发送
      chrome.tabs.sendMessage(tabId, { type: 'task.finished', task_id: msg.task_id }).catch(() => {});
    }
    else if (msg.type === 'task.error') {
      $('output').textContent += '\n[错误] ' + (msg.message || msg.code || '未知错误');
      chrome.tabs.sendMessage(tabId, { type: 'task.finished', task_id: msg.task_id }).catch(() => {});
    }
  });
  port.onDisconnect.addListener(() => {
    if (!acked && chrome.runtime.lastError) {
      $('output').textContent += '\n[错误] 与后台连接断开：' + chrome.runtime.lastError.message;
    }
  });

  // 派发任务：顶层 frame 用 sendMessage；若输入框在 iframe 中，对齐 WS 路径用 getAllFrames 广播所有 frame
  const task = {
    task_id: taskId,
    prompt,
    stream: true,
    inputSelector: cfg.inputSelector || '',
    sendSelector: cfg.sendSelector || '',
    sseField: cfg.sseField || '',
  };
  $('output').textContent += '\n[正在派发到页面…]';
  // 显式带回调：让 Chrome 不要为这条消息保持响应通道（content 端 task.run 不回响应）
  chrome.tabs.sendMessage(tabId, { type: 'task.run', task }, () => {
    const err = chrome.runtime.lastError;
    if (err && !/^The message port closed|^Receiving end does not exist|^Could not establish connection/.test(err.message)) {
      $('output').textContent += '\n[错误] 派发失败：' + err.message;
    }
  });
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (frames && frames.length) {
    for (const f of frames) {
      if (f.frameId === 0) continue; // 顶层已发过
      chrome.tabs.sendMessage(tabId, { type: 'task.run', task }, { frameId: f.frameId }, () => { chrome.runtime.lastError; });
    }
  }
}

document.addEventListener('DOMContentLoaded', refreshTabs);
$('refreshTabs').addEventListener('click', refreshTabs);
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$('send').addEventListener('click', sendMsg);
$('clear').addEventListener('click', () => { $('prompt').value = ''; $('output').textContent = ''; });

// ---------- 元素探测开关 ----------
// 持久化到 storage（pickMode 作为真值源），content.js 注入时自动读取恢复。
// popup 只需：1) 写 storage；2) 确保 content.js 已注入目标标签页；3) 下发开关消息。
function setPickTip(on, tabId) {
  const tip = $('pickTip');
  if (!tip) return;
  if (!on) { tip.textContent = '关闭'; tip.className = 'pick-tip'; return; }
  tip.textContent = '开启 → 目标页点/输入看控制台' + (tabId ? '（#' + tabId + '）' : '');
  tip.className = 'pick-tip on';
}
// 把模式下发到某标签页全部 frame（先确保 content.js 已注入）
async function pushPickMode(tabId, on) {
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }); } catch {}
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const list = (frames && frames.length) ? frames : [{ frameId: 0 }];
  for (const f of list) {
    chrome.tabs.sendMessage(tabId, { type: 'picker.toggle', on }, { frameId: f.frameId }).catch(() => {});
  }
}
async function applyPickMode(on) {
  await chrome.storage.local.set({ pickMode: on });
  const tabId = await autoMatchTab().catch(() => null);
  if (tabId != null) await pushPickMode(tabId, on).catch(() => {});
  setPickTip(on, tabId);
}
$('pickMode').addEventListener('change', (e) => applyPickMode(e.target.checked));

// 初始化：读持久化状态并显示；若开启，则对当前目标标签页补发一次（popup 重新打开时恢复）
(async () => {
  const o = await chrome.storage.local.get('pickMode');
  const on = !!o.pickMode;
  $('pickMode').checked = on;
  const tabId = await autoMatchTab().catch(() => null);
  if (on && tabId != null) await pushPickMode(tabId, true).catch(() => {});
  setPickTip(on, tabId);
})();
