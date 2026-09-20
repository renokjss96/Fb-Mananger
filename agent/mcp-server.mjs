#!/usr/bin/env node
// MCP stdio bridge cho FB Manager — tương tự fb-desktop-poster/mcp-server.mjs
// Host spawn với ELECTRON_RUN_AS_NODE=1 qua electron.exe.
// Đọc {port, token} từ %APPDATA%/fb-manager/agent-bridge.json và forward tới control API 127.0.0.1 của app.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BRIDGE_FILE = process.env.FB_MANAGER_BRIDGE_FILE || [
  path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'fb-manager', 'agent-bridge.json'),
  path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'FB Manager', 'agent-bridge.json'),
];

const obj = (properties, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  { name: 'app_status', description: 'Trạng thái FB Manager: version, số nick, Chrome đang mở.', inputSchema: obj({}) },
  { name: 'accounts_list', description: 'Danh sách nick Facebook trong FB Manager.', inputSchema: obj({}) },
  { name: 'accounts_get', description: 'Chi tiết 1 nick theo id.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'accounts_import', description: 'Import nick. text: raw bulk, format: uid|pass|2fa|cookie|...', inputSchema: obj({ text: { type: 'string' }, format: { type: 'string' } }, ['text']) },
  { name: 'accounts_update', description: 'Cập nhật nick: patch {alias,note,password,twoFa,email,passmail}', inputSchema: obj({ id: { type: 'string' }, patch: { type: 'object' } }, ['id', 'patch']) },
  { name: 'accounts_delete', description: 'Xóa nick theo id.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'totp_get', description: 'Lấy mã TOTP 6 số từ secret 2FA. Dùng id hoặc secret.', inputSchema: obj({ id: { type: 'string' }, secret: { type: 'string' } }) },
  { name: 'cookies_get', description: 'Lấy cookie header của nick. format: header (default).', inputSchema: obj({ id: { type: 'string' }, format: { type: 'string' } }, ['id']) },
  { name: 'chrome_open', description: 'Mở Chrome cho nick. mode: openOnly|uidPass|cookie. keepOpen: true = login xong giữ Chrome mở.', inputSchema: obj({ id: { type: 'string' }, mode: { type: 'string' }, keepOpen: { type: 'boolean' } }, ['id']) },
  { name: 'chrome_close', description: 'Đóng Chrome của nick.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'chrome_closeAll', description: 'Đóng mọi Chrome.', inputSchema: obj({}) },
  { name: 'chrome_capture', description: 'Bắt cookie hiện tại từ Chrome của nick.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'push_to_poster', description: 'Đẩy cookie sang FB Desktop Poster (accounts_import). ids: danh sách id; bỏ trống = đẩy tất cả có cookie.', inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } }, id: { type: 'string' } }) },
];

function readBridge() {
  for (const file of [].concat(BRIDGE_FILE)) {
    try {
      if (!existsSync(file)) continue;
      const bridge = JSON.parse(readFileSync(file, 'utf8'));
      if (bridge?.port && bridge?.token) return bridge;
    } catch {}
  }
  return null;
}

async function callOp(op, args) {
  const bridge = readBridge();
  if (!bridge || !bridge.port || !bridge.token) {
    throw new Error('FB Manager chưa chạy. Mở app FB Manager trước.');
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ op, args: args ?? {} }),
    });
  } catch {
    throw new Error('Không kết nối được FB Manager — app có thể vừa đóng.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fb-manager', version: '0.1.1' } } });
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const result = await callOp(params?.name, params?.arguments);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } });
    }
  }
  if (id !== undefined) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method không hỗ trợ: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch((error) => {
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message || error) } });
  });
});
rl.on('close', () => process.exit(0));
