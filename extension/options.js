// options.js —— 网关插件配置页（选项卡形式，每个选项卡一套完整独立配置）
const KEY = 'cfg';
const THEME_KEY = 'relayTheme';
const THEMES = ['dark', 'light', 'cyber'];

function getTheme() {
  return new Promise((res) => {
    try { chrome.storage.local.get(THEME_KEY, (o) => res(THEMES.includes(o[THEME_KEY]) ? o[THEME_KEY] : 'dark')); }
    catch { res('dark'); }
  });
}
function setTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'dark';
  document.body.dataset.theme = theme;
  try { chrome.storage.local.set({ [THEME_KEY]: theme }); } catch {}
}
const POSSIBLE = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'kimi.moonshot.cn', 'tongyi.aliyun.com', 'doubao.com', 'yuanbao.tencent.com', 'stepfun.com', 'bing.com', 'copilot.microsoft.com', 'poe.com', 'perplexity.ai', 'meta.ai', 'qianwen'];

// 标准字段（右侧由用户填网页实际路径）
const STANDARD_FIELDS = [
  { std: 'choices.0.delta.content', label: '回复文本（必填）', text: true },
  { std: 'choices.0.delta.role', label: '角色', text: false },
  { std: 'id', label: '会话/消息 ID', text: false },
  { std: 'model', label: '模型名', text: false },
  { std: 'choices.0.finish_reason', label: '结束原因', text: false },
];
const PRESETS = {
  openai: { type: 'map', fields: [
    { std: 'choices.0.delta.content', src: 'choices.0.delta.content' },
    { std: 'choices.0.delta.role', src: 'choices.0.delta.role' },
    { std: 'id', src: 'id' }, { std: 'model', src: 'model' },
    { std: 'choices.0.finish_reason', src: 'choices.0.finish_reason' } ] },
  stepfun: { type: 'map', fields: [
    { std: 'choices.0.delta.content', src: 'data.delta' },
    { std: 'choices.0.delta.role', src: 'data.role' },
    { std: 'id', src: 'message_id' }, { std: 'model', src: 'model' },
    { std: 'choices.0.finish_reason', src: 'finish_reason' } ] },
  claude: { type: 'map', fields: [
    { std: 'choices.0.delta.content', src: 'delta.text' },
    { std: 'choices.0.delta.role', src: 'delta.role' },
    { std: 'id', src: 'id' }, { std: 'model', src: 'model' },
    { std: 'choices.0.finish_reason', src: 'delta.stop_reason' } ] },
  raw: { type: 'raw' },
};
const DEFAULT_MAP = PRESETS.openai;

function isLikelyLLM(url) {
  if (!url) return false;
  return POSSIBLE.some(d => url.includes(d));
}

// 每个选项卡 = 一套完整独立配置（含独立网关连接）
function defaultTabCfg(tab) {
  return {
    enabled: false,
    // 独立网关连接
    wsUrl: 'ws://127.0.0.1:8191/ws',
    token: 'sk-demo-token',
    tag: 'chatgpt',
    models: 'chatgpt-web',
    autoConnect: true,
    // 网页信息
    title: tab ? tab.title || '' : '',
    url: tab ? tab.url || '' : '',
    favIcon: tab ? tab.favIconUrl || '' : '',
    // 路由 + 选择器 + 字段
    inputSelector: '',
    sendSelector: '',
    chatApi: '',
    ssePreset: '',
    sseField: JSON.stringify(DEFAULT_MAP),
  };
}

// 与 background 保持一致：直接读写 storage 键 'targetTabs'
function load() { return new Promise(res => chrome.storage.local.get(['targetTabs'], r => res(r.targetTabs || {}))); }
function save(targetTabs) { return new Promise(res => chrome.storage.local.set({ targetTabs }, res)); }
let currentTabs = null; // renderTabs 时缓存，供单标签自动保存使用

// ---------- 稳定身份 key：归一化网址（origin + pathname，去 query/hash） ----------
// 避免依赖浏览器临时分配的 tabId（关掉网页再开 tabId 就变了，旧逻辑会误判「已关闭」）
function normUrl(u) {
  try {
    const p = new URL(u || '');
    if (!/^https?:$/.test(p.protocol)) return (u || '').trim();
    // 去掉 query 与 hash，仅保留 origin + pathname；去尾斜杠，避免 a/ 与 a 被当作两个页面
    return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin;
  } catch {
    return (u || '').trim();
  }
}
function stableKey(tab) { return normUrl(tab.url); }
function keyOf(cfg) { return stableKey(cfg); }
// 旧版主键兼容：
function isOldKey(k) { return (k || '').includes('|'); }
function oldKeyHost(k) { return (k || '').split('|')[0] || ''; }
function keyHost(k) { return isOldKey(k) ? oldKeyHost(k) : (() => { try { return new URL(k).host; } catch { return k; } })(); }
function keyTitle(k) { return isOldKey(k) ? (k || '').split('|').slice(1).join('|') : ''; }

// 数据迁移：旧版用整型 tabId 作为 key，重开网页后 tabId 失效会误判已关闭。
// 迁移为归一化 URL 主键，并去重合并。
async function migrateKeys() {
  const tabs = await load();
  const entries = Object.entries(tabs);
  if (!entries.some(([id]) => /^\d+$/.test(id))) return; // 无旧格式，跳过
  const migrated = {};
  for (const [id, c] of entries) {
    if (/^\d+$/.test(id) && c && c.url) {
      const nk = keyOf(c);
      if (!migrated[nk]) migrated[nk] = c; // 同站点重复取第一个
    } else {
      migrated[id] = c;
    }
  }
  await save(migrated);
  currentTabs = migrated;
}

// 解析 sseField 为 {type, fields}
function parseSseRule(raw) {
  try { const r = JSON.parse(raw || ''); if (r && typeof r === 'object') return r; } catch (e) {}
  return null;
}
function renderMapTable(tbody, rule) {
  if (!tbody) return;
  tbody.innerHTML = '';
  const fields = (rule && rule.type === 'map' && Array.isArray(rule.fields)) ? rule.fields : [];
  const empty = fields.length === 0;
  STANDARD_FIELDS.forEach((f) => {
    const existing = empty ? null : fields.find((x) => (x.std || x.standard) === f.std);
    const src = existing ? (existing.src || existing.source || '') : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="std">${f.std}</span><br/><span style="color:#888">${f.label}</span></td>` +
      `<td><input type="text" data-std="${f.std}" placeholder="如 ${f.text ? 'data.delta' : '—'}" value="${escapeAttr(src)}" /></td>`;
    tbody.appendChild(tr);
  });
}
function syncPanelTable(panel) {
  const ta = panel.querySelector('.sseField');
  if (!ta) return;
  if (panel.querySelector('.rawMode') && panel.querySelector('.rawMode').checked) {
    ta.value = JSON.stringify({ type: 'raw' });
    return;
  }
  const fields = [];
  panel.querySelectorAll('.map-table tbody input').forEach((inp) => {
    const std = inp.getAttribute('data-std');
    const src = inp.value.trim();
    if (src) fields.push({ std, src });
  });
  ta.value = JSON.stringify({ type: 'map', fields });
}

// ---------- 卡片渲染 ----------
let liveMap = {}; // stableKey -> 当前真实 tabId（由 renderTabs 构建，供测试/编辑注入用）
async function renderTabs() {
  const tabs = await load();
  currentTabs = tabs;
  const cards = document.getElementById('tabCards');
  const empty = document.getElementById('tabEmpty');
  cards.innerHTML = '';

  const ids = Object.keys(tabs);
  empty.style.display = ids.length ? 'none' : 'block';

  // 构建稳定 key -> 真实 tabId 映射：遍历当前打开的标签，按归一化 URL 精确匹配
  liveMap = {};
  const live = await chrome.tabs.query({});
  const liveNorm = live.filter(t => t.url && /^https?:/.test(t.url)).map(t => ({ id: t.id, url: normUrl(t.url) }));
  for (const id of ids) {
    let hit;
    if (isOldKey(id)) {
      const host = oldKeyHost(id);
      hit = liveNorm.find(t => { try { return new URL(t.url).host === host; } catch { return false; } });
    } else {
      const nk = normUrl(id);
      hit = liveNorm.find(t => t.url === nk);
      if (!hit) { // origin 兜底：配置只填了 host 级 URL
        let origin = '';
        try { origin = new URL(id).origin; } catch {}
        if (origin) hit = liveNorm.find(t => { try { return new URL(t.url).origin === origin; } catch { return false; } });
      }
    }
    if (hit) liveMap[id] = hit.id; // 多个同站点标签取第一个匹配
  }

  for (const id of ids) {
    const c = tabs[id];
    const alive = !!liveMap[id]; // 稳定 key 在当前打开的标签中存在即视为「已激活」
    const card = document.createElement('article');
    card.className = 'card' + (c.enabled ? ' on' : '') + (alive ? '' : ' dead') + ' collapsed';
    card.dataset.tabId = id;
    let host = '';
    try { host = new URL(c.url || '').host; } catch {}
    const fav = c.favIcon ? `<img class="fav" src="${escapeAttr(c.favIcon)}" alt="" onerror="this.style.display='none'"/>` : '';
    const conn = (c.wsUrl ? hostOf(c.wsUrl) : '(未配置网关)');
    const selOk = c.inputSelector ? '已设选择器' : '未设选择器';
    card.innerHTML = `
      <header class="card-head">
        <div class="card-summary">
          ${fav}
          <div class="meta">
            <div class="ct">${escapeHtml(c.title || id)}</div>
            <div class="cu">${escapeHtml(host || c.url || '')}</div>
          </div>
          <div class="chips">
            <span class="chip ${c.enabled ? 'good' : 'off'}">${c.enabled ? '● 已启用' : '○ 已停用'}</span>
            ${alive ? '' : '<span class="chip dead">⚠ 页面未打开</span>'}
            <span class="chip">⚡ ${escapeHtml(conn)}</span>
            <span class="chip">⌖ ${escapeHtml(selOk)}</span>
            ${c.tag ? `<span class="chip">#${escapeHtml(c.tag)}</span>` : ''}
          </div>
        </div>
        <div class="card-tools">
          <label class="switch" title="${alive ? '启用该页监听并连接网关' : '页面未打开，打开对应网页后将自动激活'}">
            <input type="checkbox" class="en" ${c.enabled ? 'checked' : ''}/><span class="track"></span>
          </label>
          <button type="button" class="edit" title="打开编辑窗口">编辑</button>
          <button type="button" class="del" title="移除该标签页">×</button>
        </div>
      </header>
      <div class="card-body">
        <div class="view">
          <div class="kv"><span>网关</span><b>${escapeHtml(c.wsUrl || '(未配置)')}</b></div>
          <div class="kv"><span>Tag</span><b>${escapeHtml(c.tag || '—')}</b></div>
          <div class="kv"><span>模型</span><b>${escapeHtml(c.models || '—')}</b></div>
          <div class="kv"><span>输入框选择器</span><b class="mono">${escapeHtml(c.inputSelector || '—')}</b></div>
          <div class="kv"><span>发送按钮选择器</span><b class="mono">${escapeHtml(c.sendSelector || '—')}</b></div>
          <div class="kv"><span>对话接口路径</span><b class="mono">${escapeHtml(c.chatApi || '—')}</b></div>
          <div class="kv"><span>字段映射</span><b class="mono">${escapeHtml((c.sseField && c.sseField.trim()) ? c.sseField : '—')}</b></div>
        </div>
      </div>`;
    cards.appendChild(card);

    card.querySelector('.en').addEventListener('change', async (e) => {
      c.enabled = e.target.checked;
      card.classList.toggle('on', e.target.checked);
      currentTabs[id] = c; await save(currentTabs); notify();
    });
    card.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); confirmRemove(id, c.title || ('标签 ' + id)); });
    card.querySelector('.edit').addEventListener('click', (e) => { e.stopPropagation(); openEditModal(id); });
    card.querySelector('.card-summary').addEventListener('click', () => {
      card.classList.toggle('collapsed');
    });
  }
}

// ---------- 选择器实时测试 ----------
async function testSelector(key, selector, wantFirst, outEl) {
  if (!selector || !selector.trim()) { outEl.className = 'test-out warn'; outEl.textContent = '⚠ 请先填写选择器'; return; }
  outEl.className = 'test-out';
  outEl.textContent = '测试中…';
  // 用稳定 key 映射到当前真实 tabId（关掉网页再开 tabId 会变，但 host+标题不变）
  const tabId = liveMap[key];
  if (tabId == null) {
    outEl.className = 'test-out warn';
    outEl.textContent = '⚠ 该页面当前未打开（identity=' + key + '），请打开对应网页后点「测试」';
    return;
  }
  try {
    const resp = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('超时（页面未响应，可能未注入插件或页面受限）')), 2500);
      chrome.tabs.sendMessage(Number(tabId), { type: 'selector.test', selector, wantFirst }, (r) => {
        clearTimeout(to);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(r);
      });
    });
    const results = (resp && resp.results) || [];
    // 汇总：任一 frame 命中即视为成功
    const hit = results.find((r) => r.error === null && r.count > 0);
    if (hit) {
      outEl.className = 'test-out ok';
      const where = hit.isTop ? '顶层' : '子框架 (' + hostOf(hit.href) + ')';
      outEl.textContent = `✓ 命中 ${hit.count} 个元素，其中可见 ${hit.visibleCount} 个；首元素 <${hit.firstTag}> @${where}`;
    } else {
      const err = results.find((r) => r.error) || results[0];
      outEl.className = 'test-out fail';
      outEl.textContent = '✗ 未命中：' + (err && err.error ? err.error : '页面上无匹配元素');
    }
  } catch (e) {
    outEl.className = 'test-out fail';
    outEl.textContent = '✗ ' + e.message;
  }
}
function hostOf(href) { try { return new URL(href).host; } catch { return href; } }

async function syncPanel(c, panel, id) {
  c.wsUrl = panel.querySelector('.wsUrl').value.trim();
  c.token = panel.querySelector('.token').value.trim();
  c.tag = panel.querySelector('.tag').value.trim();
  c.models = panel.querySelector('.models').value.trim();
  c.autoConnect = panel.querySelector('.autoConnect').checked;
  c.inputSelector = panel.querySelector('.inp').value.trim();
  c.sendSelector = panel.querySelector('.snd').value.trim();
  c.chatApi = panel.querySelector('.api').value.trim();
  syncPanelTable(panel);
  c.sseField = panel.querySelector('.sseField').value;
  c.ssePreset = panel.querySelector('.preset').value;
  // 页面身份：url 与 存储键（identity）均可编辑
  c.url = panel.querySelector('.url').value.trim();
  const ikeyVal = panel.querySelector('.ikey').value.trim();
  // 存储键（identity）：手动填写优先；留空则按 url 归一化（origin + pathname）自动重算
  const newKey = ikeyVal ? normUrl(ikeyVal) : stableKey({ url: c.url });
  if (id != null && currentTabs) {
    if (newKey !== id) {
      // 主键变更：删除旧键、以新键保存（保留全部其它字段）
      delete currentTabs[id];
      currentTabs[newKey] = c;
      id = newKey;
    } else {
      currentTabs[id] = c;
    }
    await save(currentTabs);
  }
  notify();
  return id; // 可能已迁移到新键
}

// 顶部状态提示
function flashStatus(msg) {
  const s = document.getElementById('status');
  if (!s) return;
  s.textContent = msg;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => (s.textContent = ''), 1800);
}

// 生成可编辑表单 HTML（编辑弹窗与卡片共用结构）
function tabFormHTML(c, id) {
  return `
    <fieldset class="sub">
      <legend>① 网关连接（本页独立）</legend>
      <div class="grid2">
        <label>Gateway WS URL
          <input type="text" class="wsUrl" placeholder="ws://127.0.0.1:8191/ws" value="${escapeAttr(c.wsUrl)}" />
        </label>
        <label>Access Token
          <input type="text" class="token" placeholder="sk-your-token" value="${escapeAttr(c.token)}" />
        </label>
        <label>Instance / 路由 Tag
          <input type="text" class="tag" placeholder="chatgpt / claude" value="${escapeAttr(c.tag)}" />
        </label>
        <label>支持的模型（逗号分隔）
          <input type="text" class="models" placeholder="chatgpt-web" value="${escapeAttr(c.models)}" />
        </label>
      </div>
      <label class="check"><input type="checkbox" class="autoConnect" ${c.autoConnect !== false ? 'checked' : ''}/> 启用时自动连接此网关</label>
    </fieldset>
    <fieldset class="sub">
      <legend>①-0 页面身份（用于运行时匹配网页）</legend>
      <label>页面 URL
        <input type="text" class="url" placeholder="https://chatgpt.com/..." value="${escapeAttr(c.url)}" />
      </label>
      <label>存储键 / identity（即归一化网址，运行时按此精确匹配已打开的网页）
        <input type="text" class="ikey" placeholder="https://chatgpt.com/c/abc （留空则按上方 URL 自动归一化）" value="${escapeAttr(id)}" />
      </label>
      <p class="hint">提示：identity 默认 = 上方 URL 归一化（origin + pathname，去掉 ?query 与 #hash）。运行时已打开且归一化 URL 一致的网页即视为匹配。可手动填写以覆盖自动归一化结果。</p>
    </fieldset>
    <fieldset class="sub">
      <legend>② 网页监听（本页独立）</legend>
      <label>输入框 CSS 选择器 / XPath
        <span class="sel-row">
          <input type="text" class="inp" placeholder="右键元素→检查→Copy selector / Copy XPath" value="${escapeAttr(c.inputSelector)}" />
          <button type="button" class="test-btn" data-sel="inp">测试</button>
        </span>
        <span class="test-out" data-out="inp"></span>
      </label>
      <label>发送按钮 CSS 选择器 / XPath
        <span class="sel-row">
          <input type="text" class="snd" placeholder="右键元素→检查→Copy selector / Copy XPath" value="${escapeAttr(c.sendSelector)}" />
          <button type="button" class="test-btn" data-sel="snd">测试</button>
        </span>
        <span class="test-out" data-out="snd"></span>
      </label>
      <label>对话接口路径（回写命中接口，多个逗号分隔）
        <input type="text" class="api" placeholder="/api/chat" value="${escapeAttr(c.chatApi)}" />
      </label>
    </fieldset>
    <fieldset class="sub">
      <legend>③ 字段映射（本页独立）</legend>
      <label>平台预设
        <select class="preset">
          <option value="">— 选择平台预设 / 或手工填写 —</option>
          <option value="openai">OpenAI / ChatGPT / 通用</option>
          <option value="stepfun">StepFun 网页版</option>
          <option value="claude">Claude 网页版</option>
          <option value="raw">纯文本流式（无 JSON）</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" class="rawMode" ${c.sseField && parseSseRule(c.sseField) && parseSseRule(c.sseField).type === 'raw' ? 'checked' : ''}/> 纯文本模式（整行原样回传）</label>
      <table class="map-table"><thead><tr><th>标准字段（OpenAI 格式）</th><th>当前网页回复字段路径</th></tr></thead><tbody></tbody></table>
      <label>映射规则 JSON（自动同步 / 可手工微调）
        <textarea class="sseField" rows="3" placeholder='{"type":"map","fields":[{"std":"choices.0.delta.content","src":"data.delta"}]}'>${escapeHtml(c.sseField)}</textarea>
      </label>
    </fieldset>`;
}

// 编辑弹窗
let editId = null;
function openEditModal(id) {
  const c = currentTabs && currentTabs[id];
  if (!c) return;
  if (liveMap[id] == null) {
    flashStatus('该页面当前未打开（identity=' + id + '），打开对应网页后即可编辑并测试');
    // 仍打开弹窗允许编辑配置，仅测试会提示未打开
  }
  editId = id;
  document.getElementById('editTitle').textContent = c.title || ('标签 ' + id);
  const body = document.getElementById('editBody');
  body.innerHTML = tabFormHTML(c, id);
  const rule = parseSseRule(c.sseField);
  renderMapTable(body.querySelector('.map-table tbody'), rule);
  const presetSel = body.querySelector('.preset');
  if (rule) for (const [name, p] of Object.entries(PRESETS)) {
    if (JSON.stringify(p) === JSON.stringify(rule)) { presetSel.value = name; break; }
  }
  body.querySelectorAll('.test-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const selName = btn.getAttribute('data-sel');
      const selector = body.querySelector('.' + selName).value.trim();
      const out = body.querySelector('[data-out="' + selName + '"]');
      testSelector(id, selector, selName === 'inp', out);
    });
  });
  body.querySelector('.map-table').addEventListener('input', () => syncPanelTable(body));
  body.querySelector('.rawMode').addEventListener('change', () => syncPanelTable(body));
  presetSel.addEventListener('change', () => {
    const p = PRESETS[presetSel.value];
    if (!p) return;
    if (p.type === 'raw') body.querySelector('.rawMode').checked = true;
    else { body.querySelector('.rawMode').checked = false; renderMapTable(body.querySelector('.map-table tbody'), p); }
    syncPanelTable(body);
  });
  document.getElementById('editModal').style.display = 'flex';
}
function closeEditModal() {
  document.getElementById('editModal').style.display = 'none';
  editId = null;
}

// ---------- JSON 导入 / 导出 ----------
async function exportJSON() {
  const tabs = await load();
  const data = { version: 1, exportedAt: new Date().toISOString(), targetTabs: tabs || {} };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stepfun-relay-config-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flashStatus('已导出 ' + Object.keys(data.targetTabs).length + ' 个标签配置 ✓');
}

async function importJSON(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = data && data.targetTabs ? data.targetTabs : (data && typeof data === 'object' ? data : null);
    if (!incoming || typeof incoming !== 'object') throw new Error('文件格式不正确（缺少 targetTabs）');
    const tabs = await load();
    let added = 0, updated = 0;
    for (const [id, tab] of Object.entries(incoming)) {
      if (!tab || typeof tab !== 'object') continue;
      // 导入时统一按稳定 key 归并（兼容旧版整型 id 或外部导出）
      const nk = /^\d+$/.test(id) ? keyOf(tab) : id;
      if (tabs[nk]) updated++; else added++;
      tabs[nk] = Object.assign(defaultTabCfg(tab), tab);
    }
    await save(tabs);
    currentTabs = tabs;
    notify();
    await renderTabs();
    flashStatus('导入完成：新增 ' + added + '，更新 ' + updated + ' ✓');
  } catch (e) {
    flashStatus('导入失败：' + e.message);
  }
}

// ---------- 添加标签页：从当前打开的标签里挑选 ----------
async function openTabPicker() {
  const mask = document.getElementById('tabPickerMask');
  const list = document.getElementById('tabPickerList');
  list.innerHTML = '';
  const all = await chrome.tabs.query({});
  const tabs = await load();
  for (const t of all) {
    if (!t.url || !/^https?:/.test(t.url)) continue;
    const id = stableKey(t);
    const star = isLikelyLLM(t.url) ? '★ ' : '';
    const added = tabs[id] ? '（已添加）' : '';
    const item = document.createElement('div');
    item.className = 'picker-item' + (tabs[id] ? ' added' : '');
    let host = '';
    try { host = new URL(t.url).host; } catch {}
    item.innerHTML = `<span class="star">${star}</span><span class="pt">${escapeHtml(t.title || '(无标题)')}</span><span class="pu">${escapeHtml(host)}</span>`;
    item.addEventListener('click', () => { pickTab(t); });
    list.appendChild(item);
  }
  mask.style.display = 'flex';
}
function closeTabPicker() { document.getElementById('tabPickerMask').style.display = 'none'; }

async function pickTab(tab) {
  const tabs = await load();
  const id = stableKey(tab);
  if (!tabs[id]) {
    tabs[id] = defaultTabCfg(tab);
  }
  await save(tabs);
  currentTabs = tabs;
  closeTabPicker();
  notify();
  renderTabs();
}

async function removeTab(id) {
  const tabs = await load();
  delete tabs[id];
  await save(tabs);
  notify();
  renderTabs();
}

// ---------- 移除确认弹窗 ----------
let confirmCb = null;
function confirmRemove(id, name) {
  const mask = document.getElementById('confirmMask');
  document.getElementById('confirmText').innerHTML =
    '确定要移除标签页 <b>' + escapeHtml(name) + '</b> 及其全部配置吗？<br><span class="dim">此操作不可撤销。</span>';
  mask.style.display = 'flex';
  confirmCb = id;
}
function closeConfirm() {
  document.getElementById('confirmMask').style.display = 'none';
  confirmCb = null;
}

function notify() {
  chrome.runtime.sendMessage({ type: 'config.updated' }).catch(() => {});
}
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ---------- 保存全部 ----------
document.addEventListener('DOMContentLoaded', async () => {
  const theme = await getTheme();
  document.getElementById('themeSelect').value = theme;
  setTheme(theme);
  document.getElementById('themeSelect').addEventListener('change', (e) => setTheme(e.target.value));

  // 调试开关：保存 relayDebug，并广播给已打开的页面使其立即生效
  const dbgEl = document.getElementById('debugToggle');
  const dbg = !!(await chrome.storage.local.get('relayDebug')).relayDebug;
  dbgEl.checked = dbg;
  dbgEl.addEventListener('change', async () => {
    await chrome.storage.local.set({ relayDebug: dbgEl.checked });
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'relay.debug', on: dbgEl.checked }).catch(() => {});
      }
    } catch {}
  });

  // 先绑定全局控件事件，保证即使渲染异常也不影响弹窗/添加/保存
  document.getElementById('addTabTop').addEventListener('click', openTabPicker);
  document.getElementById('tabPickerCancel').addEventListener('click', closeTabPicker);
  document.getElementById('tabPickerMask').addEventListener('click', (e) => {
    if (e.target.id === 'tabPickerMask') closeTabPicker();
  });
  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  document.getElementById('confirmMask').addEventListener('click', (e) => {
    if (e.target.id === 'confirmMask') closeConfirm();
  });
  document.getElementById('confirmOk').addEventListener('click', () => {
    const id = confirmCb;
    closeConfirm();
    if (id != null) removeTab(id);
  });
  document.getElementById('exportBtn').addEventListener('click', exportJSON);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  });
  document.getElementById('editClose').addEventListener('click', closeEditModal);
  document.getElementById('editCancel').addEventListener('click', closeEditModal);
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') closeEditModal();
  });
  document.getElementById('editSave').addEventListener('click', async () => {
    if (editId == null || !currentTabs) return;
    const c = currentTabs[editId];
    if (!c) return;
    const body = document.getElementById('editBody');
    const newId = await syncPanel(c, body, editId);
    editId = newId; // 若存储键被修改，更新当前编辑 id
    closeEditModal();
    renderTabs();
    flashStatus('已保存：' + (c.title || newId) + ' ✓');
  });
  document.getElementById('saveAll').addEventListener('click', async () => {
    const cc = await load(); // 当前已自动保存，这里做一次兜底持久化
    await save(cc);
    currentTabs = cc;
    notify();
    flashStatus('全部配置已保存 ✓');
  });

  await migrateKeys(); // 旧版整型 tabId 存储迁移为归一化 URL 主键（host|标题 旧键由 isOldKey 兜底兼容）
  await renderTabs();
});
