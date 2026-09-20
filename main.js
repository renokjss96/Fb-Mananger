const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function asarUnpacked(filePath) {
  const raw = String(filePath || '');
  if (raw.includes(`${path.sep}app.asar${path.sep}`)) {
    return raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  return raw;
}

function resolveSeleniumManager() {
  const fromEnv = String(process.env.SE_MANAGER_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const packed = path.join(
    path.dirname(require.resolve('selenium-webdriver/package.json')),
    'bin',
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    process.platform === 'win32' ? 'selenium-manager.exe' : 'selenium-manager'
  );
  const unpacked = asarUnpacked(packed);
  if (fs.existsSync(unpacked)) return unpacked;
  if (fs.existsSync(packed) && !packed.includes(`${path.sep}app.asar${path.sep}`)) return packed;
  return '';
}

const seleniumManagerPath = resolveSeleniumManager();
if (seleniumManagerPath) process.env.SE_MANAGER_PATH = seleniumManagerPath;

const Store = require('./src/store');
const ChromeManager = require('./src/chrome');
const { parseBulk, previewCount, DEFAULT_FORMAT } = require('./src/importer');
const { cookieHeader, toNetscape, toJson, cookiesOnly } = require('./src/exporter');
const AgentServer = require('./src/agent');

let win = null;
let store = null;
let chrome = null;
let agent = null;

function send(ev, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ev, payload);
}

function snapshot() {
  return {
    accounts: store.list(),
    pages: store.listPages ? store.listPages() : [],
    settings: store.getSettings(),
    running: chrome.runningIds(),
    queued: chrome.queuedIds(),
    logs: chrome.recentLogs(),
    agent: agent ? { port: agent.port, enabled: agent.enabled, bridgeFile: agent.bridgeFile() } : { port: 0, enabled: false, bridgeFile: '' }
  };
}

function notifyChanged() {
  send('accounts:changed', snapshot());
}

function mcpConfigJson() {
  const exe = process.execPath;
  const mcpPath = path.join(__dirname, 'agent', 'mcp-server.mjs');
  return JSON.stringify({
    mcpServers: {
      'fb-manager': {
        command: exe,
        args: [mcpPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }, null, 2);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0b1220',
    title: 'FB Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('preload-error', preloadPath, error);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:snapshot', () => snapshot());

  ipcMain.handle('accounts:addEmpty', () => {
    const account = store.create({ status: 'idle' });
    notifyChanged();
    return { ok: true, id: account.id };
  });

  ipcMain.handle('accounts:import', (e, { text, format }) => {
    const usedFormat = String(format || store.getSettings().importFormat || DEFAULT_FORMAT);
    const { rows, skipped } = parseBulk(text, usedFormat);
    let added = 0;
    let updated = 0;
    for (const row of rows) {
      const r = store.upsertRow(row);
      if (r.added) added++;
      else updated++;
    }
    if (format) store.setSettings({ importFormat: usedFormat });
    notifyChanged();
    return { ok: true, added, updated, skipped, total: rows.length };
  });

  ipcMain.handle('accounts:importPreview', (e, { text }) => {
    return { count: previewCount(text) };
  });

  ipcMain.handle('accounts:deleteMany', async (e, { ids }) => {
    const list = Array.isArray(ids) ? ids : [];
    for (const id of list) {
      try { await chrome.wipe(id); } catch (_) { /* ignore */ }
    }
    const removed = store.removeMany(list);
    notifyChanged();
    return { ok: true, removed };
  });

  ipcMain.handle('accounts:update', (e, { id, patch }) => {
    const allowed = {};
    ['alias', 'note', 'name', 'password', 'twoFa', 'email', 'passmail'].forEach((k) => {
      if (patch && k in patch) allowed[k] = patch[k];
    });
    store.update(id, allowed);
    notifyChanged();
    return { ok: true };
  });

  ipcMain.handle('accounts:delete', async (e, { id }) => {
    try { await chrome.wipe(id); } catch (_) { /* ignore */ }
    store.remove(id);
    notifyChanged();
    return { ok: true };
  });

  ipcMain.handle('accounts:exportText', (e, { id }) => {
    const a = store.get(id);
    if (!a) return '';
    return cookieHeader(a);
  });

  ipcMain.handle('chrome:open', (e, { id, mode, keepOpen }) => {
    const a = store.get(id);
    if (!a) return { ok: false, error: 'notfound' };
    const m = String(mode || 'openOnly').trim() || 'openOnly';
    const allowed = new Set(['openOnly', 'uidPass', 'cookie']);
    return chrome.open(a, { mode: allowed.has(m) ? m : 'openOnly', keepOpen: !!keepOpen });
  });

  ipcMain.handle('chrome:close', (e, { id }) => {
    const a = store.get(id);
    if (!a) return { ok: false, error: 'notfound' };
    const r = chrome.closeById(a.id);
    if (a.status === 'running') store.update(id, { status: a.cookie ? 'idle' : 'idle' });
    notifyChanged();
    return r;
  });

  ipcMain.handle('chrome:captureNow', async (e, { id }) => {
    return chrome.captureNow(id);
  });

  ipcMain.handle('logs:clear', () => chrome.clearLogs());

  ipcMain.handle('chrome:closeAll', () => {
    chrome.shutdownAll();
    for (const a of store.list()) {
      if (a.status === 'running') store.update(a.id, { status: a.cookie ? 'idle' : 'idle' });
    }
    notifyChanged();
    return { ok: true };
  });

  ipcMain.handle('settings:set', async (e, { patch }) => {
    const prev = store.getSettings().agentEnabled;
    const next = store.setSettings(patch || {});
    if (patch && 'agentEnabled' in patch && !!patch.agentEnabled !== !!prev) {
      try {
        if (next.agentEnabled) {
          await agent.restart(true);
          chrome.status('', 'Agent MCP đã bật — port ' + agent.port);
        } else {
          await agent.restart(false);
          chrome.status('', 'Agent MCP đã tắt');
        }
      } catch (err) {
        chrome.status('', 'Agent lỗi: ' + (err.message || err));
      }
    }
    notifyChanged();
    return next;
  });

  ipcMain.handle('detect:chrome', () => chrome.resolveChrome() || '');

  ipcMain.handle('chrome:resolveInfo', async () => {
    const p = await chrome.resolveChrome() || '';
    const bundled = (() => { try { const { findBundledChrome } = require('./src/detect'); return findBundledChrome() || ''; } catch (_) { return ''; } })();
    return { path: p, bundled: bundled || '' };
  });

  ipcMain.handle('clipboard:write', (e, { text }) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('totp:get', (e, { id, secret }) => {
    const { twoFaForClipboard } = require('./src/totp');
    let sec = String(secret || '');
    if (!sec && id) {
      const a = store.get(String(id));
      if (a) sec = a.twoFa || '';
    }
    return twoFaForClipboard(sec);
  });

  ipcMain.handle('poster:push', async (e, { ids }) => {
    if (!agent || !agent.isRunning()) return { ok: false, error: 'Agent đang tắt (bật trong Cài đặt)' };
    try {
      const r = await agent.pushToPoster({ ids });
      notifyChanged();
      return r;
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('agent:status', () => {
    if (!agent) return { ok: false, error: 'Agent chưa chạy' };
    return { ok: true, port: agent.port, enabled: agent.enabled, bridgeFile: agent.bridgeFile() };
  });

  ipcMain.handle('agent:mcpConfig', () => {
    return { ok: true, json: mcpConfigJson(), bridgeFile: agent ? agent.bridgeFile() : '', enabled: agent ? agent.enabled : false, port: agent ? agent.port : 0 };
  });

  // ---- pages ----
  ipcMain.handle('pages:list', () => ({ ok: true, pages: store.listPages() }));

  ipcMain.handle('pages:restrictLog', () => {
    try {
      const { getLogFilePath } = require('./src/pages');
      const fs2 = require('fs');
      const p = getLogFilePath();
      const exists = fs2.existsSync(p);
      const text = exists ? fs2.readFileSync(p, 'utf8') : '';
      // chỉ trả 200 dòng cuối để không nặng
      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(-200).join('\n');
      return { ok: true, path: p, exists, lines: lines.length, tail };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('pages:restrictLogPath', () => {
    try { const { getLogFilePath } = require('./src/pages'); return { ok: true, path: getLogFilePath() }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('pages:restrictLogClear', () => {
    try {
      const { getLogFilePath } = require('./src/pages');
      const fs2 = require('fs');
      const p = getLogFilePath();
      if (fs2.existsSync(p)) fs2.writeFileSync(p, '', 'utf8');
      return { ok: true, path: p };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('pages:scan', async (e, { ids }) => {
    const filterIds = Array.isArray(ids) && ids.length ? ids.map(String) : null;
    const targets = filterIds
      ? store.list().filter((a) => filterIds.includes(a.id))
      : store.list().filter((a) => a.cookie && String(a.cookie).trim());
    if (!targets.length) return { ok: false, error: 'Không có nick có cookie để quét' };
    chrome.status('', `Quét Page: ${targets.length} nick...`);
    const { scanForAccounts } = require('./src/pages');
    const pages = await scanForAccounts(targets, (ev) => {
      if (ev.error) chrome.status('', `Quét ${ev.uid || ''}: lỗi ${ev.error}`);
      else if (ev.count === 0) chrome.status('', `Quét ${ev.uid}: không có page (hoặc không có quyền)`);
      else chrome.status('', `Quét ${ev.uid}: ${ev.count} page`);
    }, store);
    const res = store.upsertPages(pages);
    notifyChanged();
    if (pages.length === 0) chrome.status('', `Quét xong: không có page nào (kiểm tra cookie/TK)`);
    else chrome.status('', `Quét xong: ${pages.length} page (${res.added} mới, ${res.updated} cập nhật)`);
    return { ok: true, scanned: targets.length, found: pages.length, ...res };
  });

  ipcMain.handle('pages:remove', (e, { pageIds }) => {
    const n = store.removePages(pageIds || []);
    notifyChanged();
    return { ok: true, removed: n };
  });

  ipcMain.handle('pages:open', async (e, { pageId }) => {
    const p = store.getPage(String(pageId || ''));
    if (!p) return { ok: false, error: 'Không tìm thấy page' };
    const owner = store.get(String(p.ownerId));
    if (!owner) return { ok: false, error: 'Không tìm thấy owner' };
    const url = p.url || `https://facebook.com/${p.pageId}`;
    // mở bằng Chrome profile của owner
    const r = await chrome.open(owner, { mode: 'openOnly', keepOpen: true });
    // đợi chrome mở rồi navigate tới page
    if (r && (r.ok || r.started || r.already)) {
      // chuyển trang sau khi driver sẵn sàng (poll nhỏ)
      setTimeout(async () => {
        try {
          const driver = chrome.drivers.get(owner.id);
          if (driver) await driver.get(url);
        } catch (_) {}
      }, 1200);
    }
    return { ok: true, url, ownerId: owner.id };
  });

  ipcMain.handle('pages:setRestriction', async (e, { pageIds, country_list, is_blocklist }) => {
    const ids = (Array.isArray(pageIds) ? pageIds : [pageIds]).map(String).filter(Boolean);
    if (!ids.length) return { ok: false, error: 'Chưa chọn page' };
    const list = (Array.isArray(country_list) ? country_list : String(country_list || '').split(/[,\s]+/)).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    const isBlock = is_blocklist !== false;
    const { cookieHeader } = require('./src/exporter');
    const { setCountryRestrictionWithCache } = require('./src/pages');
    const batchDelay = store.getSettings().batchDelay || 800;
    const groups = new Map();
    for (const pid of ids) {
      const p = store.getPage(pid);
      if (!p) continue;
      const k = p.ownerId || '_unknown';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    let ok = 0, fail = 0;
    const errors = [];
    for (const [ownerId, gpages] of groups) {
      const owner = store.get(ownerId);
      const cookie = owner ? (owner.cookie || cookieHeader(owner)) : '';
      if (!cookie) {
        for (const p of gpages) { fail++; errors.push(`${p.pageId}: owner ${ownerId} không có cookie`); }
        continue;
      }
      const cached = store.getOwnerTokens ? store.getOwnerTokens(ownerId) : null;
      for (let i = 0; i < gpages.length; i++) {
        const p = gpages[i];
        try {
          const r = await setCountryRestrictionWithCache(cookie, p.pageId, list, isBlock, cached, store);
          if (r && r.freshTokens) store.setOwnerTokens(ownerId, r.freshTokens);
          store.updatePageRestriction(p.pageId, list, isBlock);
          ok++;
          chrome.status(p.pageId, `Đã đổi ${p.pageId}: [${list.join(',') || 'rỗng'}] ${isBlock ? 'chặn' : 'allow'}`);
        } catch (err) {
          fail++;
          const msg = String(err.message || err).slice(0, 220);
          errors.push(`${p.pageId}: ${msg}`);
          chrome.status(p.pageId, `Lỗi đổi ${p.pageId}: ${msg}`);
        }
        if (i < gpages.length - 1 && batchDelay > 0) await new Promise((r) => setTimeout(r, batchDelay));
      }
      if (batchDelay > 0) await new Promise((r) => setTimeout(r, Math.min(batchDelay, 400)));
    }
    notifyChanged();
    return { ok: fail === 0, changed: ok, failed: fail, errors: errors.slice(0, 10), country_list: list, is_blocklist: isBlock };
  });

  ipcMain.handle('pages:export', async (e, { pageIds }) => {
    const ids2 = Array.isArray(pageIds) ? pageIds.map(String) : [];
    const wanted2 = ids2.length ? store.listPages().filter((p) => ids2.includes(p.pageId) || ids2.includes(p.id)) : store.listPages();
    if (!wanted2.length) return { ok: false, error: 'Không có page để xuất' };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Xuất page',
      defaultPath: `fb-pages-${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'cancel' };
    const header = 'pageId,name,url,category,ownerUid,country_list,is_blocklist\n';
    const rows = wanted2.map((p) => [p.pageId, `"${String(p.name).replace(/"/g, '""')}"`, p.url, p.category, p.ownerUid, (p.country_list || []).join('|'), p.is_blocklist ? '1' : '0'].join(',')).join('\n');
    fs.writeFileSync(filePath, header + rows, 'utf8');
    return { ok: true, filePath, count: wanted2.length };
  });

  ipcMain.handle('export:cookies', async (e, { ids, format }) => {
    const wanted = Array.isArray(ids) && ids.length
      ? ids.map((id) => store.get(id)).filter(Boolean)
      : store.list();
    const withCookie = wanted.filter((a) => cookieHeader(a));
    if (!withCookie.length) return { ok: false, error: 'Không có cookie để xuất' };

    const kind = format || 'header';
    const ext = kind === 'json' ? 'json' : 'txt';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Xuất cookie',
      defaultPath: `fb-cookies-${Date.now()}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    });
    if (canceled || !filePath) return { ok: false, error: 'cancel' };

    let content;
    if (kind === 'json') {
      content = JSON.stringify(withCookie.map((a) => ({
        uid: a.uid,
        cookie: cookieHeader(a),
        cookies: a.cookies
      })), null, 2);
    } else if (kind === 'netscape') {
      content = withCookie.map(toNetscape).join('\n');
    } else {
      content = cookiesOnly(withCookie);
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath, count: withCookie.length };
  });
}

function resolveDataRoot() {
  // Ưu tiên data cạnh tool (portable) — giống bản chromedriver cũ
  const candidates = [];
  try {
    if (app.isPackaged) candidates.push(path.join(path.dirname(app.getPath('exe')), 'data'));
    candidates.push(path.join(__dirname, 'data'));
  } catch (_) {}
  for (const p of candidates) {
    try {
      fs.mkdirSync(p, { recursive: true });
      const probe = path.join(p, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return p;
    } catch (_) { /* không ghi được -> thử chỗ khác */ }
  }
  return app.getPath('userData');
}

function migrateIfNeeded(dataRoot, userData) {
  if (dataRoot === userData) return;
  const newFile = path.join(dataRoot, 'fb-manager-data.json');
  const oldFile = path.join(userData, 'fb-manager-data.json');
  try {
    if (!fs.existsSync(newFile) && fs.existsSync(oldFile)) {
      fs.copyFileSync(oldFile, newFile);
    }
  } catch (_) {}
  const newProfiles = path.join(dataRoot, 'profiles');
  const oldProfiles = path.join(userData, 'profiles');
  try {
    if (!fs.existsSync(newProfiles) && fs.existsSync(oldProfiles)) {
      fs.mkdirSync(newProfiles, { recursive: true });
      for (const name of fs.readdirSync(oldProfiles)) {
        const src = path.join(oldProfiles, name);
        const dst = path.join(newProfiles, name);
        try {
          if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const dataRoot = resolveDataRoot();
  migrateIfNeeded(dataRoot, userData);
  store = new Store(path.join(dataRoot, 'fb-manager-data.json'));
  store.load();
  chrome = new ChromeManager(store, (ev, payload) => {
    if (ev === 'accounts:changed') notifyChanged();
    else send(ev, payload);
  }, path.join(dataRoot, 'profiles'));
  agent = new AgentServer(store, chrome);
  agent.enabled = store.getSettings().agentEnabled !== false;
  if (agent.enabled) {
    try { await agent.start(); } catch (err) { console.error('agent start failed', err); }
  }
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  try { chrome.shutdownAll(); } catch (_) { /* ignore */ }
  try { agent && agent.stop(); } catch (_) { /* ignore */ }
  app.quit();
});
