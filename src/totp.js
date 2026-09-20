const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const cleaned = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!cleaned) return null;
  let bits = '';
  for (const ch of cleaned) {
    const val = ALPHABET.indexOf(ch);
    if (val < 0) return null;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

function looksLikeSecret(value) {
  const cleaned = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length < 16 || cleaned.length > 64) return false;
  if (/^\d{6,8}$/.test(cleaned)) return false;
  return /^[A-Z2-7]+=*$/.test(cleaned);
}

function generateTotp(secret, { step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  if (!key) return '';
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const code = bin % (10 ** digits);
  return String(code).padStart(digits, '0');
}

function twoFaForClipboard(twoFa) {
  const raw = String(twoFa || '').trim();
  if (!raw) return { text: '', kind: '' };
  if (looksLikeSecret(raw)) {
    const code = generateTotp(raw);
    return code ? { text: code, kind: 'totp' } : { text: raw, kind: 'secret' };
  }
  return { text: raw, kind: 'code' };
}

module.exports = { generateTotp, looksLikeSecret, twoFaForClipboard };
