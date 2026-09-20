const $ = (sel) => document.querySelector(sel);

let accounts = [];
let settings = {};
let running = [];
let currentView = 'accounts';
let editId = null;
let toastTimer = null;
let logs = [];
const selected = new Set();
// ---- pages state ----
let pages = [];
const selectedPages = new Set();
let pagesBlockFilter = 'all';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function invoke(channel, payload) {
  if (!window.api || typeof window.api.invoke !== 'function') {
    throw new Error('Preload chưa sẵn sàng — mở lại app bằng start.bat');
  }
  return window.api.invoke(channel, payload);
}

function on(sel, ev, fn) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.addEventListener(ev, fn);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function fmtLogTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendLogLine(entry) {
  if (!entry) return;
  logs.push(entry);
  if (logs.length > 200) logs = logs.slice(-200);
  renderLogs();
  const a = accounts.find((x) => x.id === entry.id);
  const nick = entry.id ? displayName(a || { uid: entry.id }) : '';
  const txt = (nick ? `[${nick}] ` : '') + (entry.message || '');
  const bar = $('#logText');
  if (bar) bar.textContent = txt;
}

function renderLogs() {
  const line = (e) => {
    const a = accounts.find((x) => x.id === e.id);
    const hasAcc = !!a;
    const nick = e.id ? displayName(a || { uid: e.id }) : '';
    // status của page: không có account tương ứng thì để trống, tránh nhúng UID page sai
    const prefix = e.id && hasAcc ? `[${nick}] ` : (e.id ? '' : '');
    return `${fmtLogTime(e.time)}  ${prefix}${e.message || ''}`;
  };
  const text = logs.map(line).join('\n');
  const box = $('#logBox');
  if (box) { box.textContent = text; box.scrollTop = box.scrollHeight; }
  const box2 = $('#logBoxPages');
  if (box2) { box2.textContent = text; box2.scrollTop = box2.scrollHeight; }
}

function setLog(msg) {
  appendLogLine({ id: '', message: msg, time: Date.now() });
}

function isRunning(id) {
  return running.includes(id);
}

function statusOf(a) {
  if (a.status === 'checkpoint' || a.status === 'dead' || a.status === 'live') return a.status;
  if (isRunning(a.id) || a.status === 'running') return 'running';
  return a.status || 'idle';
}

function statusLabel(s, code) {
  if (s === 'checkpoint') return code ? `CP ${code}` : 'Checkpoint';
  return {
    live: 'Live',
    dead: 'Dead',
    checkpoint: 'Checkpoint',
    running: 'Đang mở',
    idle: 'Idle'
  }[s] || 'Idle';
}

function displayName(a) {
  return a.alias || a.name || (a.uid ? 'UID ' + a.uid : 'Nick mới');
}

function filtered() {
  const q = ($('#search').value || '').toLowerCase().trim();
  if (!q) return accounts;
  return accounts.filter((a) =>
    [a.uid, a.password, a.twoFa, a.cookie, a.email, a.passmail, a.alias, a.name, a.note]
      .join(' ')
      .toLowerCase()
      .includes(q)
  );
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '—';
  return '•'.repeat(Math.min(10, Math.max(4, s.length > 16 ? 10 : s.length)));
}

function cellHtml(account, key) {
  const value = account[key] || '';
  if (key === 'cookie') {
    return value
      ? `<span class="cookie-ok" title="${esc(value)}">✓ ${value.length} ký tự</span>`
      : '<span class="cookie-no">Chưa có</span>';
  }
  if (key === 'password' || key === 'twoFa' || key === 'passmail') {
    return `<span class="secret" title="${value ? 'Đã lưu' : ''}">${esc(maskSecret(value))}</span>`;
  }
  if (key === 'uid') {
    return `<span class="uid" title="${esc(value)}">${esc(value || '—')}</span>`;
  }
  return `<span title="${esc(value)}">${esc(value || '—')}</span>`;
}

function selectedIds() {
  return [...selected].filter((id) => accounts.some((a) => a.id === id));
}

function pruneSelection() {
  const ids = new Set(accounts.map((a) => a.id));
  for (const id of [...selected]) {
    if (!ids.has(id)) selected.delete(id);
  }
}

function selectedPageIds() {
  const ids = [...selectedPages];
  const valid = new Set(pages.map((p) => p.pageId));
  return ids.filter((id) => valid.has(id));
}
function prunePagesSelection() {
  const ids = new Set(pages.map((p) => p.pageId));
  for (const id of [...selectedPages]) if (!ids.has(id)) selectedPages.delete(id);
}
function fmtFan(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K';
  return String(v);
}
function restrictionLabel(p) {
  const list = Array.isArray(p.country_list) ? p.country_list : [];
  if (!list.length) return '<span class="tag none">Không chặn</span>';
  const isBlock = !!p.is_blocklist;
  const cls = isBlock ? 'block' : 'allow';
  const label = isBlock ? 'Chặn' : 'Whitelist';
  const chips = list.slice(0, 3).map((c) => `<span>${esc(c)}</span>`).join('');
  const more = list.length > 3 ? `<span>+${list.length - 3}</span>` : '';
  return `<span class="tag ${cls}">${label}</span> <span class="country">${chips}${more}</span>`;
}
function filteredPages() {
  const q = ($('#searchPages') ? $('#searchPages').value : '' || '').toLowerCase().trim();
  const ownerSel = $('#pagesUserFilter') ? $('#pagesUserFilter').value : '';
  let rows = pages.slice();
  if (q) {
    rows = rows.filter((p) => [p.name, p.pageId, p.category, p.ownerUid].join(' ').toLowerCase().includes(q));
  }
  if (ownerSel) rows = rows.filter((p) => String(p.ownerId) === String(ownerSel));
  if (pagesBlockFilter !== 'all') {
    rows = rows.filter((p) => {
      const list = Array.isArray(p.country_list) ? p.country_list : [];
      if (pagesBlockFilter === 'none') return list.length === 0;
      if (pagesBlockFilter === 'allow') return list.length > 0 && !p.is_blocklist;
      if (pagesBlockFilter === 'block-CA') return list.includes('CA') && !!p.is_blocklist;
      if (pagesBlockFilter === 'block-VN') return list.includes('VN') && !!p.is_blocklist;
      return true;
    });
  }
  return rows;
}

function renderKpi() {
  const live = accounts.filter((a) => a.status === 'live').length;
  const die = accounts.filter((a) => a.status === 'dead' || a.status === 'checkpoint').length;
  $('#kpi').innerHTML = `
    <div class="card"><div class="k">Tổng nick</div><div class="v">${accounts.length}</div></div>
    <div class="card"><div class="k">Live</div><div class="v">${live}</div></div>
    <div class="card"><div class="k">Die / CP</div><div class="v">${die}</div></div>
    <div class="card"><div class="k">Đã chọn</div><div class="v">${selectedIds().length}</div></div>
  `;
  const cookiesReady = accounts.filter((a) => a.cookie).length;
  const side = $('#sideStats');
  if (side) {
    side.innerHTML = `
      ${accounts.length} nick trong kho<br>
      ${running.length} Chrome đang mở<br>
      ${cookiesReady} cookie sẵn sàng xuất
    `;
  }
}

function renderTable() {
  pruneSelection();
  const rows = filtered();
  const visibleIds = rows.map((a) => a.id);
  const allVisible = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const chkAll = $('#chkAll');
  if (chkAll) {
    chkAll.checked = allVisible;
    chkAll.indeterminate = !allVisible && visibleIds.some((id) => selected.has(id));
  }

  $('#tbody').innerHTML = rows.map((a) => {
    const st = statusOf(a);
    return `<tr data-id="${a.id}" class="${selected.has(a.id) ? 'picked' : ''}">
      <td class="chk"><input type="checkbox" class="row-chk" data-id="${a.id}" ${selected.has(a.id) ? 'checked' : ''} /></td>
      <td>${cellHtml(a, 'uid')}</td>
      <td>${cellHtml(a, 'password')}</td>
      <td>${cellHtml(a, 'twoFa')}</td>
      <td>${cellHtml(a, 'cookie')}</td>
      <td>${cellHtml(a, 'email')}</td>
      <td>${cellHtml(a, 'passmail')}</td>
      <td><span class="tag ${st}">${statusLabel(st, a.checkpointCode)}</span></td>
    </tr>`;
  }).join('');
  $('#empty').classList.toggle('hidden', rows.length > 0);
  updateBulkButtons();
}

function updateBulkButtons() {
  const n = selectedIds().length;
  const del = $('#btnDeleteSelected');
  const exp = $('#btnExportCookies');
  if (del) del.textContent = n ? `Xóa nick (${n})` : 'Xóa nick';
  if (exp) exp.textContent = n ? `Xuất cookie (${n})` : 'Xuất cookie';
  const openBtn = $('#btnOpenBrowser');
  const passBtn = $('#btnLoginPass');
  const cookieBtn = $('#btnLoginCookie');
  if (openBtn) openBtn.disabled = false;
  if (passBtn) passBtn.disabled = false;
  if (cookieBtn) cookieBtn.disabled = false;
  // legacy button if still present
  const legacy = $('#btnLoginSelected');
  if (legacy) legacy.textContent = n ? `Login Chrome (${n})` : 'Login Chrome';
}

function renderPagesKpi() {
  const el = $('#kpiPages');
  if (!el) return;
  const blocking = pages.filter((p) => Array.isArray(p.country_list) && p.country_list.length > 0 && !!p.is_blocklist).length;
  const sel = selectedPageIds().length;
  el.innerHTML = `
    <div class="card"><div class="k">Tổng Page</div><div class="v">${pages.length}</div></div>
    <div class="card"><div class="k">Đang chặn</div><div class="v">${blocking}</div></div>
    <div class="card"><div class="k">Không chặn</div><div class="v">${pages.length - blocking}</div></div>
    <div class="card"><div class="k">Đã chọn</div><div class="v">${sel}</div></div>
  `;
}
function pagesUserLabel(a) {
  const hasCookie = !!(a.cookie && String(a.cookie).trim());
  const isCp = a.status === 'checkpoint';
  const tag = !hasCookie ? ' — chưa có cookie' : isCp ? ` — CP ${a.checkpointCode || ''}`.trim() : '';
  const base = a.alias || a.name || a.uid || String(a.id).slice(0, 8);
  return `${base}${tag}`;
}
function renderPagesFilter() {
  const sel = $('#pagesUserFilter');
  if (!sel) return;
  const cur = sel.value;
  // Hiển thị TẤT CẢ user, không chỉ owner có page — để chọn quét đúng user
  const pageCountByOwner = new Map();
  for (const p of pages) {
    const k = String(p.ownerId);
    pageCountByOwner.set(k, (pageCountByOwner.get(k) || 0) + 1);
  }
  const opts = ['<option value="">Tất cả user</option>'].concat(accounts.map((a) => {
    const cnt = pageCountByOwner.get(String(a.id)) || 0;
    const suffix = cnt ? ` — ${cnt} page` : ' — 0 page';
    const statusNote = a.status === 'checkpoint' ? ' · CP' : (!a.cookie ? ' · no cookie' : '');
    return `<option value="${esc(a.id)}">${esc(pagesUserLabel(a) + suffix + statusNote)}</option>`;
  }));
  sel.innerHTML = opts.join('');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function renderPagesTable() {
  prunePagesSelection();
  const rows = filteredPages();
  const hint = $('#pagesHint');
  if (hint) hint.textContent = `${rows.length}/${pages.length} page${selectedPageIds().length ? ` · đã chọn ${selectedPageIds().length}` : ''}`;
  renderPagesKpi();
  renderPagesFilter();
  const visibleIds = rows.map((p) => p.pageId);
  const allVisible = visibleIds.length > 0 && visibleIds.every((id) => selectedPages.has(id));
  const chkAll = $('#chkPagesAll');
  if (chkAll) {
    chkAll.checked = allVisible;
    chkAll.indeterminate = !allVisible && visibleIds.some((id) => selectedPages.has(id));
  }
  const tbody = $('#tbodyPages');
  if (!tbody) return;
  const ownerMap = new Map(accounts.map((a) => [String(a.id), a]));
  tbody.innerHTML = rows.map((p) => {
    const owner = ownerMap.get(String(p.ownerId));
    const ownerLabel = owner ? (owner.alias || owner.uid || String(p.ownerUid || '').slice(0, 12)) : (p.ownerUid || '—');
    const av = p.avatar ? `<img src="${esc(p.avatar)}" alt="" />` : esc(String(p.name || '?').slice(0, 2).toUpperCase());
    const fan = fmtFan(p.fan_count != null ? p.fan_count : p.followers_count);
    const pub = p.is_published == null ? '<span class="tag none">—</span>' : (p.is_published ? '<span class="tag live">Đã XB</span>' : '<span class="tag dead">Chưa XB</span>');
    return `<tr data-page-id="${esc(p.pageId)}" class="${selectedPages.has(p.pageId) ? 'picked' : ''}">
      <td class="chk"><input type="checkbox" class="row-chk-page" data-page-id="${esc(p.pageId)}" ${selectedPages.has(p.pageId) ? 'checked' : ''} /></td>
      <td><div class="page-cell"><div class="page-av">${av}</div><div><div class="page-name">${esc(p.name || p.pageId)}</div></div></div></td>
      <td style="text-align:right; font-family: ui-monospace, Consolas, monospace; font-size:12.5px">${esc(fan)}</td>
      <td>${pub}</td>
      <td>${esc(p.category || '—')}</td>
      <td class="owner">${esc(ownerLabel)}<small>${esc(p.ownerUid || '')}</small></td>
      <td>${restrictionLabel(p)}</td>
    </tr>`;
  }).join('');
  const empty = $('#emptyPages');
  if (empty) empty.classList.toggle('hidden', rows.length > 0 || pages.length > 0);
  const bulk = $('#btnPagesBulk');
  const rm = $('#btnPagesRemove');
  if (bulk) bulk.textContent = selectedPageIds().length ? `Đổi quốc gia (${selectedPageIds().length})` : 'Đổi quốc gia';
  if (rm) rm.disabled = selectedPageIds().length === 0;
}

function render() {
  try { renderKpi(); } catch (err) { console.error('renderKpi', err); }
  try { renderTable(); } catch (err) { console.error('renderTable', err); }
  try { renderPagesTable(); } catch (err) { console.error('renderPagesTable', err); }
}

let agentInfo = { port: 0, enabled: true, bridgeFile: '' };

async function refresh() {
  const snap = await invoke('app:snapshot');
  accounts = snap.accounts || [];
  pages = Array.isArray(snap.pages) ? snap.pages : [];
  settings = snap.settings || {};
  running = snap.running || [];
  if (snap.agent) agentInfo = snap.agent;
  if (Array.isArray(snap.logs)) logs = snap.logs.slice(-200);
  render();
  renderLogs();
  fillSettings();
  refreshAgentPanel();
}

async function refreshAgentPanel() {
  try {
    const r = await invoke('agent:mcpConfig');
    if (r && r.json) {
      const pre = $('#mcpPreview');
      if (pre) pre.textContent = r.json;
      const bf = $('#setAgentBridge');
      if (bf) bf.value = r.bridgeFile || '';
      const hint = $('#agentHint');
      if (hint) hint.textContent = r.enabled ? `Agent đang bật — port ${r.port} — bridge: ${r.bridgeFile}` : 'Agent đang tắt — bật toggle để mở lại';
    }
  } catch (_) {}
}

function fillSettings() {
  const active = document.activeElement;
  if (
    active === $('#setChromePath') ||
    active === $('#setDelay') ||
    active === $('#setImportFormat') ||
    active === $('#setThreads') ||
    active === $('#setHideBrowser') ||
    active === $('#setAgentEnabled') ||
    active === $('#setAgentBridge')
  ) return;
  $('#setChromePath').value = settings.chromePath || '';
  $('#setDelay').value = settings.batchDelay || 800;
  $('#setThreads').value = settings.threads || 1;
  $('#setHideBrowser').checked = !!settings.hideBrowser;
  $('#setImportFormat').value = settings.importFormat || 'uid|pass|2fa|cookie|email|passmail';
  const ae = $('#setAgentEnabled');
  if (ae) ae.checked = settings.agentEnabled !== false;
  const eng = (settings.chromeEngine || 'bundled');
  const rb = document.querySelector(`input[name="chromeEngine"][value="${eng}"]`);
  if (rb) rb.checked = true;
  refreshChromeEngineUi();
}

function refreshChromeEngineUi() {
  const eng = (document.querySelector('input[name="chromeEngine"]:checked') || {}).value || settings.chromeEngine || 'bundled';
  const row = $('#setChromePath') ? $('#setChromePath').closest('.row') : null;
  if (row) row.style.opacity = eng === 'system' ? '1' : '0.45';
  const inp = $('#setChromePath');
  if (inp) inp.disabled = eng !== 'system';
  const btn = $('#btnDetectChrome');
  if (btn) btn.disabled = eng !== 'system';
  const hint = $('#chromeEngineHint');
  if (hint) hint.textContent = eng === 'system'
    ? 'System: dùng Chrome/Edge đã cài. Nhập đường dẫn chrome.exe hoặc bấm Dò tìm.'
    : 'Bundled: dùng Chrome kèm sẵn trong app (resources/chrome). Không cần Chrome máy, mở nhanh, không lệch driver.';
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  $('#viewAccounts').classList.toggle('hidden', view !== 'accounts');
  $('#viewPages').classList.toggle('hidden', view !== 'pages');
  $('#viewSettings').classList.toggle('hidden', view !== 'settings');
  $('#topActionsAccounts').classList.toggle('hidden', view !== 'accounts');
  $('#topActionsPages').classList.toggle('hidden', view !== 'pages');
  const TITLES = { accounts: 'Tài khoản', pages: 'Page', settings: 'Cài đặt' };
  const DESCS = {
    accounts: 'Import nick, login Chrome lấy cookie, xuất cookie.',
    pages: 'Quét Page từ nick có cookie, đổi hạn chế quốc gia theo đúng tài khoản sở hữu.',
    settings: 'Chrome path, số luồng, ẩn trình duyệt, format import.',
  };
  $('#pageTitle').textContent = TITLES[view] || TITLES.accounts;
  $('#pageDesc').textContent = DESCS[view] || DESCS.accounts;
}

function closeCopyPop() {
  const el = $('#copyPop');
  if (el) el.remove();
}

function closeCtxMenu() {
  const el = $('#ctxMenu');
  if (el) el.remove();
  document.querySelectorAll('tr.ctx-target').forEach((tr) => tr.classList.remove('ctx-target'));
}

function closeMenus() {
  closeCopyPop();
  closeCtxMenu();
}

function placeFixedMenu(el, x, y) {
  document.body.appendChild(el);
  const pad = 8;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - w - pad));
  const top = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - h - pad));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

async function copyClipboard(text, label) {
  const value = String(text || '');
  if (!value) {
    toast('Không có ' + label);
    return;
  }
  await invoke('clipboard:write', { text: value });
  toast('Đã copy ' + label);
}

async function copyCookie(account) {
  if (!account || !account.cookie) {
    toast('Nick chưa có cookie');
    return;
  }
  const text = await invoke('accounts:exportText', { id: account.id });
  await invoke('clipboard:write', { text });
  toast('Đã copy cookie');
}

async function copy2faTotp(account) {
  if (!account || !account.twoFa) {
    toast('Nick chưa có 2FA');
    return;
  }
  try {
    const r = await invoke('totp:get', { id: account.id });
    const code = (r && r.text) ? r.text : '';
    if (!code) {
      toast('Không sinh được mã 2FA');
      return;
    }
    await invoke('clipboard:write', { text: code });
    const kind = r.kind === 'totp' ? 'TOTP' : r.kind === 'secret' ? 'secret' : 'mã';
    toast('Đã copy 2FA (' + kind + '): ' + code);
  } catch (err) {
    toast(String(err.message || err));
  }
}

function openEdit(a) {
  editId = a.id;
  $('#editAlias').value = a.alias || a.name || '';
  $('#editNote').value = a.note || '';
  $('#editPass').value = a.password || '';
  $('#editTwoFa').value = a.twoFa || '';
  $('#editEmail').value = a.email || '';
  $('#editPassmail').value = a.passmail || '';
  $('#dlgEdit').showModal();
}

async function deleteNick(id) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  if (!confirm(`Xóa nick ${displayName(a)}?`)) return;
  await invoke('accounts:delete', { id });
  selected.delete(id);
  toast('Đã xóa nick');
  await refresh();
}

async function handleRowAction(action, id) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  if (action === 'open') {
    await openChromeFor(id, 'openOnly');
    refresh();
  } else if (action === 'login-pass') {
    await openChromeFor(id, 'uidPass');
    refresh();
  } else if (action === 'login-cookie') {
    await openChromeFor(id, 'cookie');
    refresh();
  } else if (action === 'close') {
    await invoke('chrome:close', { id });
    setLog('Đã đóng Chrome.');
    refresh();
  } else if (action === 'capture') {
    const r = await invoke('chrome:captureNow', { id });
    toast(r.ok ? (r.saved ? 'Đã bắt cookie' : 'Chưa có cookie facebook.com mới') : ('Lỗi: ' + r.error));
    refresh();
  } else if (action === 'edit') {
    openEdit(a);
  } else if (action === 'delete') {
    await deleteNick(id);
  } else if (action === 'copy-cookie') {
    await copyCookie(a);
  } else if (action === 'copy-uid') {
    await copyClipboard(a.uid, 'UID');
  } else if (action === 'copy-pass') {
    await copyClipboard(a.password, 'mật khẩu');
  } else if (action === 'copy-2fa') {
    await copy2faTotp(a);
  } else if (action === 'copy-email') {
    await copyClipboard(a.email, 'email');
  } else if (action === 'push-poster') {
    try {
      const r = await invoke('poster:push', { ids: [a.id] });
      if (!r.ok) toast('Poster lỗi: ' + (r.error || 'unknown'));
      else toast('Đã đẩy ' + (r.pushed || 1) + ' cookie sang Poster');
    } catch (err) { toast(String(err.message || err)); }
  }
}

function showCtxMenu(e, account) {
  closeMenus();
  const run = statusOf(account) === 'running';
  const hasCookie = !!account.cookie;
  const hasPass = !!(account.password && (account.uid || account.email));
  const pop = document.createElement('div');
  pop.id = 'ctxMenu';
  pop.className = 'ctx-menu';
  pop.innerHTML = `
    <div class="ctx-head">${esc(displayName(account))}<span>${esc(account.uid || 'Chưa có UID')}</span></div>
    <div class="ctx-sep"></div>
    ${run
      ? `<button data-act="capture">Bắt cookie</button>
         <button data-act="close">Đóng Chrome</button>`
      : `<button data-act="open">Mở trình duyệt</button>
         <button data-act="login-pass" ${hasPass ? '' : 'disabled'}>Đăng nhập UID/Pass</button>
         <button data-act="login-cookie" ${hasCookie ? '' : 'disabled'}>Đăng nhập Cookie</button>`}
    <div class="ctx-sep"></div>
    <button data-act="copy-cookie" ${hasCookie ? '' : 'disabled'}>Copy Cookie</button>
    <button data-act="copy-uid" ${account.uid ? '' : 'disabled'}>Copy UID</button>
    <button data-act="copy-pass" ${account.password ? '' : 'disabled'}>Copy mật khẩu</button>
    <button data-act="copy-2fa" ${account.twoFa ? '' : 'disabled'}>Copy 2FA</button>
    <button data-act="copy-email" ${account.email ? '' : 'disabled'}>Copy email</button>
    <div class="ctx-sep"></div>
    <button data-act="push-poster" ${hasCookie ? '' : 'disabled'}>Đẩy sang Poster</button>
    <div class="ctx-sep"></div>
    <button data-act="edit">Sửa nick</button>
    <button data-act="delete" class="danger">Xóa nick</button>
  `;
  placeFixedMenu(pop, e.clientX, e.clientY);
  const tr = document.querySelector(`#tbody tr[data-id="${account.id}"]`);
  if (tr) tr.classList.add('ctx-target');
  pop.addEventListener('contextmenu', (ev) => ev.preventDefault());
  pop.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    closeMenus();
    try {
      await handleRowAction(act, account.id);
    } catch (err) {
      toast(String(err.message || err));
    }
  });
}

async function openChromeFor(id, mode, keepOpen) {
  const m = String(mode || 'openOnly').trim() || 'openOnly';
  const r = await invoke('chrome:open', { id, mode: m, keepOpen: !!keepOpen });
  if (!r || r.ok === false) {
    toast('Lỗi Chrome: ' + (r && r.error ? r.error : 'unknown'));
    return false;
  }
  if (r.already) setLog('Chrome đã mở sẵn.');
  else if (r.queued) setLog('Nick vào hàng chờ — đợi luồng trống.');
  else if (r.started) setLog(`${m === 'cookie' ? 'Login Cookie' : m === 'uidPass' ? 'Login UID/Pass' : 'Mở trình duyệt'}: đang khởi động Chrome...`);
  else {
    const label = m === 'cookie' ? 'Login Cookie' : m === 'uidPass' ? 'Login UID/Pass' : 'Mở trình duyệt';
    setLog(`${label}: đã mở Chrome Selenium${r.hidden ? ' ẩn' : ''}.`);
  }
  return true;
}

async function openSelected(mode, keepOpen) {
  const m = String(mode || 'openOnly').trim() || 'openOnly';
  const ids = selectedIds();
  if (!ids.length) {
    toast('Tích chọn nick trước');
    return;
  }
  let ok = 0;
  for (const id of ids) {
    if (await openChromeFor(id, m, keepOpen)) ok++;
  }
  const label = m === 'cookie' ? 'Login Cookie' : m === 'uidPass' ? 'Login UID/Pass' : 'Mở trình duyệt';
  toast(`${label}: đã mở Chrome cho ${ok}/${ids.length} nick`);
  refresh();
}

async function addNickAndLogin() {
  const r = await invoke('accounts:addEmpty');
  if (!r.ok) return toast('Không tạo được nick');
  selected.clear();
  selected.add(r.id);
  const open = await openChromeFor(r.id, 'openOnly');
  if (open) setLog('Đã mở Chrome — đăng nhập Facebook, cookie sẽ tự bắt.');
  refresh();
}

function openImport() {
  $('#importFormat').value = settings.importFormat || 'uid|pass|2fa|cookie|email|passmail';
  $('#importText').value = '';
  $('#importPreview').textContent = '';
  $('#dlgImport').showModal();
}

function openExport() {
  const n = selectedIds().length;
  $('#exportHint').textContent = n
    ? `Xuất cookie của ${n} nick đã chọn.`
    : 'Không chọn nick nào — sẽ xuất cookie của tất cả nick có cookie.';
  $('#dlgExport').showModal();
}

async function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length) {
    toast('Chọn nick cần xóa trước');
    return;
  }
  if (!confirm(`Xóa ${ids.length} nick đã chọn?`)) return;
  const r = await invoke('accounts:deleteMany', { ids });
  ids.forEach((id) => selected.delete(id));
  toast(`Đã xóa ${r.removed || ids.length} nick`);
  await refresh();
}

function wire() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav-item');
    if (nav && nav.dataset.view) {
      setView(nav.dataset.view);
      return;
    }
    const btn = e.target.closest('button');
    if (!btn || btn.closest('#tbody') || btn.closest('#copyPop') || btn.closest('#ctxMenu')) return;
    switch (btn.id) {
      case 'btnAdd':
      case 'btnEmptyAdd':
        addNickAndLogin();
        break;
      case 'btnLoginSelected':
        // legacy — treat as UID/Pass
        openSelected('uidPass');
        break;
      case 'btnOpenBrowser':
        openSelected('openOnly');
        break;
      case 'btnLoginPass':
        openSelected('uidPass', false);
        break;
      case 'btnLoginPassKeep':
        openSelected('uidPass', true);
        break;
      case 'btnLoginCookie':
        openSelected('cookie');
        break;
      case 'btnImport':
      case 'btnEmptyImport':
        openImport();
        break;
      case 'btnExportCookies':
        openExport();
        break;
      case 'btnPushPoster':
        (async () => {
          const ids = selectedIds();
          if (!ids.length) { toast('Chọn nick cần đẩy trước'); return; }
          try {
            const r = await invoke('poster:push', { ids });
            if (!r.ok) toast('Poster lỗi: ' + (r.error || 'unknown'));
            else toast('Đã đẩy ' + (r.pushed || ids.length) + ' cookie sang Poster');
          } catch (err) { toast(String(err.message || err)); }
        })();
        break;
      case 'btnDeleteSelected':
        deleteSelected();
        break;
      case 'btnCloseAll':
        invoke('chrome:closeAll').then(() => {
          setLog('Đã đóng mọi Chrome của tool.');
          refresh();
        }).catch((err) => toast(String(err.message || err)));
        break;
      case 'btnClearLogs':
        logs = [];
        renderLogs();
        invoke('logs:clear').catch(() => {});
        $('#logText').textContent = 'Sẵn sàng.';
        break;
      case 'btnImportCancel':
        $('#dlgImport') && $('#dlgImport').close();
        break;
      case 'btnImportDo':
        (async () => {
          const format = $('#importFormat').value.trim();
          const r = await invoke('accounts:import', { text: $('#importText').value, format });
          $('#dlgImport').close();
          toast(`Import: +${r.added} mới, ${r.updated} cập nhật${r.skipped ? `, ${r.skipped} bỏ qua` : ''}`);
          refresh();
        })().catch((err) => toast(String(err.message || err)));
        break;
      case 'btnExportCancel':
        $('#dlgExport') && $('#dlgExport').close();
        break;
      case 'btnExportDo':
        (async () => {
          const fmt = (document.querySelector('input[name="exportFmt"]:checked') || {}).value || 'header';
          const r = await invoke('export:cookies', { ids: selectedIds(), format: fmt });
          $('#dlgExport').close();
          if (!r.ok) {
            if (r.error !== 'cancel') toast(r.error || 'Không xuất được');
            return;
          }
          toast(`Đã xuất ${r.count} cookie`);
          setLog('Đã xuất: ' + r.filePath);
        })().catch((err) => toast(String(err.message || err)));
        break;
      case 'btnEditCancel':
        $('#dlgEdit') && $('#dlgEdit').close();
        break;
      case 'btnEditSave':
        (async () => {
          if (!editId) return;
          await invoke('accounts:update', {
            id: editId,
            patch: {
              alias: $('#editAlias').value,
              note: $('#editNote').value,
              password: $('#editPass').value,
              twoFa: $('#editTwoFa').value,
              email: $('#editEmail').value,
              passmail: $('#editPassmail').value
            }
          });
          $('#dlgEdit').close();
          toast('Đã lưu');
          refresh();
        })().catch((err) => toast(String(err.message || err)));
        break;
      case 'btnDetectChrome':
        invoke('detect:chrome').then((p) => {
          if (p) {
            $('#setChromePath').value = p;
            toast('Tìm thấy Chrome');
          } else toast('Không tìm thấy Chrome/Edge');
        }).catch((err) => toast(String(err.message || err)));
        break;
      case 'btnSaveSettings':
        invoke('settings:set', {
          patch: {
            chromeEngine: (document.querySelector('input[name="chromeEngine"]:checked') || {}).value || 'bundled',
            chromePath: $('#setChromePath').value.trim(),
            batchDelay: parseInt($('#setDelay').value, 10) || 800,
            threads: parseInt($('#setThreads').value, 10) || 1,
            hideBrowser: $('#setHideBrowser').checked,
            importFormat: $('#setImportFormat').value.trim() || 'uid|pass|2fa|cookie|email|passmail',
            agentEnabled: $('#setAgentEnabled') ? $('#setAgentEnabled').checked : true
          }
        }).then((next) => {
          settings = next;
          toast('Đã lưu cài đặt');
          refreshAgentPanel();
        }).catch((err) => toast(String(err.message || err)));
        break;
      case 'btnCopyMcp':
        (async () => {
          try {
            const r = await invoke('agent:mcpConfig');
            await invoke('clipboard:write', { text: r.json });
            toast('Đã copy cấu hình MCP');
          } catch (err) { toast(String(err.message || err)); }
        })();
        break;
      default:
        break;
    }
  });

  on('#search', 'input', renderTable);
  on('#chkAll', 'change', () => {
    const rows = filtered();
    if ($('#chkAll').checked) rows.forEach((a) => selected.add(a.id));
    else rows.forEach((a) => selected.delete(a.id));
    render();
  });
  on('#importText', 'input', () => {
    const n = $('#importText').value.split(/\r?\n/).filter((l) => {
      const line = l.trim();
      return line && !line.startsWith('#') && !line.startsWith('//');
    }).length;
    $('#importPreview').textContent = n ? `${n} dòng` : '';
  });

  on('#tbody', 'click', (e) => {
    const chk = e.target.closest('.row-chk');
    if (chk) {
      const id = chk.dataset.id;
      if (chk.checked) selected.add(id);
      else selected.delete(id);
      render();
    }
  });

  on('#tbody', 'contextmenu', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const a = accounts.find((x) => x.id === tr.dataset.id);
    if (!a) return;
    e.preventDefault();
    showCtxMenu(e, a);
  });

  document.querySelectorAll('input[name="chromeEngine"]').forEach((el) => {
    el.addEventListener('change', refreshChromeEngineUi);
  });

  on('#setAgentEnabled', 'change', () => {
    const v = $('#setAgentEnabled').checked;
    invoke('settings:set', { patch: { agentEnabled: v } }).then((next) => {
      settings = next;
      refreshAgentPanel();
      toast(v ? 'Agent đã bật' : 'Agent đã tắt');
    }).catch((err) => toast(String(err.message || err)));
  });

  // ---- pages wiring ----
  on('#searchPages', 'input', renderPagesTable);
  on('#pagesUserFilter', 'change', renderPagesTable);
  on('#chkPagesAll', 'change', () => {
    const rows = filteredPages();
    if ($('#chkPagesAll').checked) rows.forEach((p) => selectedPages.add(p.pageId));
    else rows.forEach((p) => selectedPages.delete(p.pageId));
    renderPagesTable();
  });
  document.querySelectorAll('#pagesFilterBar .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#pagesFilterBar .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      pagesBlockFilter = chip.dataset.block || 'all';
      renderPagesTable();
    });
  });
  function openPagesRestrict(ids) {
    const arr = (ids || []).map(String).filter(Boolean);
    if (!arr.length) { toast('Chưa chọn page'); return; }
    selectedPages.clear();
    arr.forEach((id) => selectedPages.add(id));
    renderPagesTable();
    const hint = $('#dlgRestrictHint');
    if (hint) {
      if (arr.length === 1) {
        const t = pages.find((p) => p.pageId === arr[0]);
        hint.textContent = t ? `Áp dụng cho 1 page: ${t.name} (${t.pageId})` : 'Áp dụng cho 1 page.';
      } else hint.textContent = `Áp dụng cho ${arr.length} page đã chọn.`;
    }
    $('#dlgPageRestrict').showModal();
  }
  async function openPageInOwnerChrome(pageId) {
    const pid = String(pageId || '').trim();
    if (!pid) return;
    try {
      const r = await invoke('pages:open', { pageId: pid });
      if (!r.ok) toast(r.error || 'Không mở được page');
      else toast('Đã mở page: ' + (r.url || pid));
    } catch (err) { toast(String(err.message || err)); }
  }
  function showPagesCtxMenu(e, page) {
    closeMenus();
    const pop = document.createElement('div');
    pop.id = 'ctxMenu';
    pop.className = 'ctx-menu';
    const isPicked = selectedPages.has(page.pageId);
    pop.innerHTML = `
      <div class="ctx-head">${esc(page.name || page.pageId)}<span>${esc(page.pageId)} · ${esc(page.category || '')}</span></div>
      <div class="ctx-sep"></div>
      <button data-act="open-page">Mở page (Chrome owner)</button>
      <button data-act="avatar-one">Đổi avatar (chọn ảnh)…</button>
      <button data-act="copy-page-id">Copy Page ID</button>
      <button data-act="copy-page-url">Copy link page</button>
      <div class="ctx-sep"></div>
      <button data-act="restrict-this">Đổi hạn chế quốc gia…</button>
      <button data-act="restrict-ca">Chặn CA</button>
      <button data-act="restrict-vn">Chặn VN</button>
      <button data-act="restrict-clear">Gỡ hết chặn</button>
      <div class="ctx-sep"></div>
      <button data-act="toggle-pick">${isPicked ? 'Bỏ chọn' : 'Chọn page này'}</button>
    `;
    placeFixedMenu(pop, e.clientX, e.clientY);
    const tr = document.querySelector(`#tbodyPages tr[data-page-id="${CSS.escape(page.pageId)}"]`);
    if (tr) tr.classList.add('ctx-target');
    pop.addEventListener('contextmenu', (ev) => ev.preventDefault());
    pop.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      closeMenus();
      if (act === 'open-page') await openPageInOwnerChrome(page.pageId);
      else if (act === 'avatar-one') openAvatarDialog([page.pageId]);
      else if (act === 'copy-page-id') { await invoke('clipboard:write', { text: page.pageId }); toast('Đã copy Page ID'); }
      else if (act === 'copy-page-url') { const u = page.url || `https://facebook.com/${page.pageId}`; await invoke('clipboard:write', { text: u }); toast('Đã copy link page'); }
      else if (act === 'restrict-this') openPagesRestrict([page.pageId]);
      else if (act === 'restrict-ca') {
        try { const r = await invoke('pages:setRestriction', { pageIds: [page.pageId], country_list: ['CA'], is_blocklist: true }); toast(r.ok ? 'Đã chặn CA' : (r.errors && r.errors[0]) || 'Lỗi'); await refresh(); } catch (err) { toast(String(err.message || err)); }
      }
      else if (act === 'restrict-vn') {
        try { const r = await invoke('pages:setRestriction', { pageIds: [page.pageId], country_list: ['VN'], is_blocklist: true }); toast(r.ok ? 'Đã chặn VN' : (r.errors && r.errors[0]) || 'Lỗi'); await refresh(); } catch (err) { toast(String(err.message || err)); }
      }
      else if (act === 'restrict-clear') {
        try { const r = await invoke('pages:setRestriction', { pageIds: [page.pageId], country_list: [], is_blocklist: true }); toast(r.ok ? 'Đã gỡ chặn' : (r.errors && r.errors[0]) || 'Lỗi'); await refresh(); } catch (err) { toast(String(err.message || err)); }
      }
      else if (act === 'toggle-pick') {
        if (selectedPages.has(page.pageId)) selectedPages.delete(page.pageId); else selectedPages.add(page.pageId);
        renderPagesTable();
      }
    });
  }
  on('#tbodyPages', 'click', (e) => {
    const chk = e.target.closest('.row-chk-page');
    if (chk) {
      const id = chk.dataset.pageId;
      if (chk.checked) selectedPages.add(id);
      else selectedPages.delete(id);
      renderPagesTable();
      return;
    }
    const btn = e.target.closest('.btn-page-restrict');
    if (btn) {
      e.preventDefault();
      const pid = btn.dataset.pageId;
      const p = pages.find((x) => x.pageId === pid);
      if (p) showPagesCtxMenu(e, p);
    }
  });
  on('#tbodyPages', 'contextmenu', (e) => {
    const tr = e.target.closest('tr[data-page-id]');
    if (!tr) return;
    const pid = tr.dataset.pageId;
    const p = pages.find((x) => x.pageId === pid);
    if (!p) return;
    e.preventDefault();
    showPagesCtxMenu(e, p);
  });
  on('#btnPagesScan', 'click', async () => {
    const selUser = $('#pagesUserFilter') ? String($('#pagesUserFilter').value || '').trim() : '';
    const targetIds = selUser ? [selUser] : null;
    // Nếu chọn user cụ thể mà user đó không có cookie thì báo ngay, không quét all
    if (targetIds) {
      const owner = accounts.find((a) => String(a.id) === String(selUser));
      const ck = owner ? (owner.cookie || '') : '';
      if (!ck || !String(ck).trim()) {
        toast('User được chọn chưa có cookie — login trước');
        return;
      }
    }
    const btn = $('#btnPagesScan');
    if (btn) btn.disabled = true;
    try {
      setLog(selUser ? `Đang quét Page của 1 user...` : 'Đang quét Page từ nick có cookie...');
      const r = await invoke('pages:scan', targetIds ? { ids: targetIds } : {});
      if (!r.ok) toast(r.error || 'Quét thất bại');
      else if (r.found === 0) toast('Không có page (hoặc cookie die/không có quyền)');
      else toast(`Quét xong: ${r.found} page (${r.added} mới, ${r.updated} cập nhật)`);
      await refresh();
    } catch (err) { toast(String(err.message || err)); }
    finally { if (btn) btn.disabled = false; }
  });
  on('#btnEmptyPagesScan', 'click', () => { const b = $('#btnPagesScan'); if (b) b.click(); });
  on('#btnPagesExport', 'click', async () => {
    try {
      const ids = selectedPageIds();
      const r = await invoke('pages:export', { pageIds: ids });
      if (!r.ok) { if (r.error !== 'cancel') toast(r.error || 'Xuất thất bại'); return; }
      toast(`Đã xuất ${r.count} page`); setLog('Đã xuất: ' + r.filePath);
    } catch (err) { toast(String(err.message || err)); }
  });
  on('#btnPagesRemove', 'click', async () => {
    const ids = selectedPageIds();
    if (!ids.length) { toast('Chọn page cần gỡ trước'); return; }
    if (!confirm(`Gỡ ${ids.length} page khỏi danh sách?`)) return;
    const r = await invoke('pages:remove', { pageIds: ids });
    ids.forEach((id) => selectedPages.delete(id));
    toast(`Đã gỡ ${r.removed || ids.length} page`);
    await refresh();
  });
  on('#btnPagesBulk', 'click', () => { openPagesRestrict(selectedPageIds()); });
  // ---- avatar ----
  let avatarPick = { filePath: '', folder: '', files: [] };
  function refreshAvatarChoice() {
    const info = $('#avatarChoiceInfo');
    const title = $('#dlgAvatarTitle');
    const hint = $('#dlgAvatarHint');
    const n = selectedPageIds().length;
    if (title) title.textContent = n <= 1 ? 'Đổi avatar' : `Đổi avatar (${n} page)`;
    if (hint) hint.textContent = n <= 1 ? 'Chọn 1 ảnh cho 1 page.' : `Đã chọn ${n} page — chọn thư mục để random mỗi page 1 ảnh.`;
    if (!info) return;
    if (avatarPick.folder) info.textContent = `Thư mục: ${avatarPick.folder} — ${avatarPick.files.length} ảnh (random)`;
    else if (avatarPick.filePath) info.textContent = `Ảnh: ${avatarPick.filePath}`;
    else info.textContent = 'Chưa chọn ảnh/thư mục';
  }
  function openAvatarDialog(ids) {
    const arr = (ids || []).map(String).filter(Boolean);
    if (!arr.length) { toast('Chưa chọn page'); return; }
    selectedPages.clear(); arr.forEach((id) => selectedPages.add(id)); renderPagesTable();
    avatarPick = { filePath: '', folder: '', files: [] };
    refreshAvatarChoice();
    $('#dlgPageAvatar').showModal();
  }
  on('#btnAvatarPickFile', 'click', async () => {
    const r = await invoke('pages:pickImage', {});
    if (!r.ok) { if (r.error !== 'cancel') toast(r.error || 'Không chọn được ảnh'); return; }
    avatarPick = { filePath: r.filePath, folder: '', files: [r.filePath] };
    refreshAvatarChoice(); toast('Đã chọn ảnh: ' + r.filePath.split(/[\\/]/).pop());
  });
  on('#btnAvatarPickFolder', 'click', async () => {
    const r = await invoke('pages:pickFolder', {});
    if (!r.ok) { if (r.error !== 'cancel') toast(r.error || 'Không chọn được thư mục'); return; }
    avatarPick = { filePath: '', folder: r.folder, files: r.files };
    refreshAvatarChoice(); toast(`Thư mục ${r.count} ảnh`);
  });
  on('#btnAvatarClear', 'click', () => { avatarPick = { filePath: '', folder: '', files: [] }; refreshAvatarChoice(); });
  on('#btnAvatarCancel', 'click', () => { const d=$('#dlgPageAvatar'); if(d) d.close(); });
  on('#btnAvatarDo', 'click', async () => {
    const ids = selectedPageIds();
    if (!ids.length) { toast('Chưa chọn page'); return; }
    if (!avatarPick.filePath && !avatarPick.folder) { toast('Chọn ảnh hoặc thư mục trước'); return; }
    const needFolder = ids.length > 1;
    if (needFolder && !avatarPick.folder) {
      if (!confirm(`Đã chọn ${ids.length} page nhưng chỉ chọn 1 ảnh — sẽ dùng cùng 1 ảnh cho tất cả. Chọn thư mục để random? Bấm OK để tiếp tục, Cancel để chọn thư mục.`)) return;
    }
    const btn = $('#btnAvatarDo'); if (btn) btn.disabled = true;
    try {
      setLog(`Đang đổi avatar cho ${ids.length} page...`);
      const r = await invoke('pages:setAvatar', avatarPick.folder ? { pageIds: ids, folder: avatarPick.folder } : { pageIds: ids, filePath: avatarPick.filePath });
      if (r && r.ok) toast(`Đã đổi avatar ${r.changed} page`);
      else toast(`Xong: ${r.changed || 0} ok, ${r.failed || 0} lỗi${r.errors && r.errors[0] ? ' — ' + r.errors[0] : ''}`);
      const d=$('#dlgPageAvatar'); if(d) d.close();
      await refresh();
    } catch (err) { toast(String(err.message || err)); }
    finally { if (btn) btn.disabled = false; }
  });
  on('#btnPagesAvatar', 'click', () => openAvatarDialog(selectedPageIds()));
  on('#btnRestrictCancel', 'click', () => { const d = $('#dlgPageRestrict'); if (d) d.close(); });
  on('#btnRestrictDo', 'click', async () => {
    const ids = selectedPageIds();
    if (!ids.length) { toast('Chưa chọn page'); return; }
    const mode = (document.querySelector('input[name="restrictMode"]:checked') || {}).value || 'block';
    const raw = ($('#restrictCountries') ? $('#restrictCountries').value : '').trim();
    const list = mode === 'clear' ? [] : raw.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const isBlock = mode !== 'allow';
    const btn = $('#btnRestrictDo');
    if (btn) btn.disabled = true;
    try {
      const r = await invoke('pages:setRestriction', { pageIds: ids, country_list: list, is_blocklist: mode === 'clear' ? true : isBlock });
      if (r && r.ok) toast(`Đã đổi ${r.changed || ids.length} page`);
      else toast(`Đổi xong: ${r.changed || 0} ok, ${r.failed || 0} lỗi${r.errors && r.errors[0] ? ' — ' + r.errors[0] : ''}`);
      const d = $('#dlgPageRestrict'); if (d) d.close();
      await refresh();
    } catch (err) { toast(String(err.message || err)); }
    finally { if (btn) btn.disabled = false; }
  });
  on('#btnClearLogs2', 'click', () => { logs = []; renderLogs(); invoke('logs:clear').catch(() => {}); const t=$('#logText'); if(t) t.textContent='Sẵn sàng.'; });
  document.querySelectorAll('#restrictQuick button').forEach((b) => {
    b.addEventListener('click', () => {
      const inp = $('#restrictCountries');
      if (inp) inp.value = b.dataset.c || '';
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    if (e.target.closest('#copyPop') || e.target.closest('#ctxMenu') || e.target.closest('.act-copy')) return;
    closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });
  window.addEventListener('blur', closeMenus);
  window.addEventListener('resize', closeMenus);
  const tablePanel = document.querySelector('#viewAccounts .panel');
  if (tablePanel) tablePanel.addEventListener('scroll', closeMenus);
  const pagesPanel = document.querySelector('#viewPages .panel');
  if (pagesPanel) pagesPanel.addEventListener('scroll', closeMenus);

  if (window.api && typeof window.api.on === 'function') {
    window.api.on('accounts:changed', (snap) => {
      accounts = snap.accounts || [];
      pages = Array.isArray(snap.pages) ? snap.pages : pages;
      settings = snap.settings || {};
      running = snap.running || [];
      if (Array.isArray(snap.logs)) logs = snap.logs.slice(-200);
      render();
      renderLogs();
    });
    window.api.on('status', (entry) => appendLogLine(entry));
    window.api.on('log:cleared', () => {
      logs = [];
      renderLogs();
    });
  } else {
    setLog('Preload lỗi — đóng app, chạy lại start.bat');
  }
}

try {
  wire();
  refresh().catch((err) => setLog('Không kết nối main: ' + (err.message || err)));
} catch (err) {
  setLog('JS lỗi: ' + (err.message || err));
}
