const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function bridgePaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(appData, 'fb-manager', 'agent-bridge.json'),
    path.join(appData, 'FB Manager', 'agent-bridge.json'),
  ];
}

function posterBridgePaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(appData, 'FB Desktop Poster', 'agent-bridge.json'),
    path.join(appData, 'fb-desktop-poster', 'agent-bridge.json'),
    path.join(localAppData, 'Programs', '@smart-studiofb-desktop-poster', 'resources', 'agent-bridge.json'),
  ];
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

class AgentServer {
  constructor(store, chrome) {
    this.store = store;
    this.chrome = chrome;
    this.server = null;
    this.port = 0;
    this.tok = '';
    this.enabled = true;
  }

  bridgeFile() {
    return bridgePaths()[0];
  }

  async start() {
    if (!this.enabled) return null;
    this.tok = token();
    const srv = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      srv.listen(0, '127.0.0.1', () => resolve());
      srv.on('error', reject);
    });
    this.server = srv;
    this.port = srv.address().port;
    this.writeBridge();
    this.log('Agent MCP đã bật — port ' + this.port);
    return { port: this.port, token: this.tok };
  }

  writeBridge() {
    const file = this.bridgeFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ port: this.port, token: this.tok }, null, 2), 'utf8');
    } catch (_) { /* ignore */ }
  }

  clearBridge() {
    try { fs.unlinkSync(this.bridgeFile()); } catch (_) {}
  }

  async restart(enabled) {
    const want = !!enabled;
    if (want === this.enabled && this.server) return { port: this.port };
    this.enabled = want;
    if (!want) {
      this.stop();
      return { port: 0, enabled: false };
    }
    if (this.server) this.stop();
    return this.start();
  }

  stop() {
    this.clearBridge();
    try { this.server && this.server.close(); } catch (_) {}
    this.server = null;
    this.port = 0;
    this.tok = '';
  }

  isRunning() { return !!this.server; }

  log(message) {
    try { this.chrome && this.chrome.status('', String(message)); } catch (_) {}
  }

  send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  async handle(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      return this.send(res, 200, { ok: true, port: this.port, enabled: this.enabled });
    }
    if (req.method !== 'POST' || req.url !== '/call') {
      return this.send(res, 404, { ok: false, error: 'not found' });
    }
    if (!this.enabled || !this.server) {
      return this.send(res, 200, { ok: false, error: 'Agent đang tắt (bật trong Cài đặt)' });
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${this.tok}`) {
      return this.send(res, 401, { ok: false, error: 'unauthorized' });
    }
    const body = await this.readBody(req);
    const op = String(body.op || '');
    const args = body.args || {};
    try {
      const result = await this.dispatch(op, args);
      this.send(res, 200, { ok: true, result });
    } catch (e) {
      this.send(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  async dispatch(op, args) {
    const store = this.store;
    const chrome = this.chrome;
    switch (op) {
      case 'app_status': {
        return {
          version: '0.1.1',
          agentEnabled: this.enabled,
          agentPort: this.port,
          accounts: store.list().length,
          running: chrome.runningIds(),
          queued: chrome.queuedIds(),
        };
      }
      case 'accounts_list': {
        return store.list().map((a) => ({
          id: a.id, uid: a.uid, name: a.name, alias: a.alias,
          email: a.email, status: a.status, checkpointCode: a.checkpointCode,
          hasCookie: !!a.cookie, cookieLen: (a.cookie || '').length,
          hasPass: !!a.password, has2fa: !!a.twoFa,
        }));
      }
      case 'accounts_get': {
        const a = store.get(String(args.id || ''));
        if (!a) throw new Error('not found');
        return a;
      }
      case 'accounts_import': {
        const { parseBulk, DEFAULT_FORMAT } = require('./importer');
        const fmt = String(args.format || store.getSettings().importFormat || DEFAULT_FORMAT);
        const { rows } = parseBulk(String(args.text || ''), fmt);
        let added = 0, updated = 0;
        for (const r of rows) {
          const x = store.upsertRow(r);
          if (x.added) added++; else updated++;
        }
        this.log(`MCP import: +${added} mới, ${updated} cập nhật`);
        return { added, updated, total: rows.length };
      }
      case 'accounts_update': {
        const a = store.update(String(args.id || ''), args.patch || {});
        if (!a) throw new Error('not found');
        return { ok: true };
      }
      case 'accounts_delete': {
        const id = String(args.id || '');
        try { await chrome.wipe(id); } catch (_) {}
        const r = store.remove(id);
        if (!r) throw new Error('not found');
        return { ok: true };
      }
      case 'totp_get': {
        const { twoFaForClipboard } = require('./totp');
        let secret = String(args.secret || '');
        if (!secret && args.id) {
          const a = store.get(String(args.id));
          if (!a) throw new Error('not found');
          secret = a.twoFa || '';
        }
        const out = twoFaForClipboard(secret);
        return out;
      }
      case 'cookies_get': {
        const { cookieHeader, toNetscape, toJson } = require('./exporter');
        const a = store.get(String(args.id || ''));
        if (!a) throw new Error('not found');
        const fmt = String(args.format || 'header');
        if (fmt === 'netscape') return toNetscape(a);
        if (fmt === 'json') return toJson(a);
        return cookieHeader(a);
      }
      case 'chrome_open': {
        const a = store.get(String(args.id || ''));
        if (!a) throw new Error('not found');
        const m = String(args.mode || 'openOnly');
        const allowed = new Set(['openOnly', 'uidPass', 'cookie']);
        return chrome.open(a, { mode: allowed.has(m) ? m : 'openOnly', keepOpen: !!args.keepOpen });
      }
      case 'chrome_close': {
        return chrome.closeById(String(args.id || ''));
      }
      case 'chrome_closeAll': {
        return chrome.shutdownAll() || { ok: true };
      }
      case 'chrome_capture': {
        return chrome.captureNow(String(args.id || ''));
      }
      case 'push_to_poster': {
        return this.pushToPoster(args);
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  async pushToPoster(args) {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : (args.id ? [String(args.id)] : []);
    const wanted = ids.length ? ids.map((id) => this.store.get(id)).filter(Boolean) : this.store.list().filter((a) => a.cookie);
    const withCookie = wanted.filter((a) => a.cookie);
    if (!withCookie.length) throw new Error('Không có cookie để đẩy');

    this.log(`Đẩy sang Poster: ${withCookie.length} cookie (${withCookie.map((a) => a.uid || a.id).join(', ')})...`);

    let bridge = null;
    for (const p of posterBridgePaths()) {
      try {
        if (!fs.existsSync(p)) continue;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j && j.port && j.token) { bridge = j; break; }
      } catch (_) {}
    }
    try {
      const alt = path.join(os.homedir(), 'AppData', 'Roaming', 'FB Desktop Poster', 'agent-bridge.json');
      if (!bridge && fs.existsSync(alt)) {
        const j = JSON.parse(fs.readFileSync(alt, 'utf8'));
        if (j && j.port && j.token) bridge = j;
      }
    } catch (_) {}

    if (!bridge) {
      const msg = 'FB Desktop Poster chưa chạy hoặc Agent chưa bật (không tìm thấy agent-bridge.json)';
      this.log('Đẩy sang Poster thất bại: ' + msg);
      throw new Error(msg);
    }

    const { cookieHeader } = require('./exporter');
    const text = withCookie.map((a) => cookieHeader(a)).join('\n\n');

    let res, data;
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ op: 'accounts_import', args: { text } }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      const msg = 'Không kết nối được Poster: ' + (e.message || e);
      this.log('Đẩy sang Poster thất bại: ' + msg);
      throw new Error(msg);
    }
    if (!res.ok || data.ok === false) {
      const msg = data.error || `Poster trả lỗi HTTP ${res.status}`;
      this.log('Đẩy sang Poster thất bại: ' + msg);
      throw new Error(msg);
    }
    this.log(`Đẩy sang Poster thành công: ${withCookie.length} cookie — Poster: ${JSON.stringify(data.result).slice(0, 200)}`);
    if (data.result && Array.isArray(data.result.ids) && data.result.ids.length) {
      try {
        await fetch(`http://127.0.0.1:${bridge.port}/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
          body: JSON.stringify({ op: 'accounts_load_info', args: { ids: data.result.ids } }),
        });
        this.log('Đã gọi Poster accounts_load_info cho ' + data.result.ids.length + ' nick');
      } catch (_) {}
    }
    return { ok: true, pushed: withCookie.length, posterResult: data.result };
  }
}

module.exports = AgentServer;
