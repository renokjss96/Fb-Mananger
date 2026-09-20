const { parseCookieString } = require('./exporter');

const FIELD_ALIASES = {
  uid: 'uid',
  id: 'uid',
  user: 'uid',
  userid: 'uid',
  pass: 'password',
  password: 'password',
  pwd: 'password',
  mk: 'password',
  '2fa': 'twoFa',
  twofa: 'twoFa',
  totp: 'twoFa',
  fa: 'twoFa',
  secret: 'twoFa',
  cookie: 'cookie',
  cookies: 'cookie',
  ck: 'cookie',
  email: 'email',
  mail: 'email',
  passmail: 'passmail',
  mailpass: 'passmail',
  emailpass: 'passmail',
  passemail: 'passmail',
  name: 'name',
  note: 'note',
  ua: 'userAgent',
  useragent: 'userAgent',
  skip: 'skip',
  _: 'skip'
};

const DEFAULT_FORMAT = 'uid|pass|2fa|cookie|email|passmail';

function cookieStringFromList(list) {
  return (list || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

function extractUid(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)c_user=(\d+)/);
  return m ? m[1] : '';
}

function normalizeField(token) {
  const key = String(token || '').trim().toLowerCase().replace(/[\s-]+/g, '');
  return FIELD_ALIASES[key] || '';
}

function parseFormat(format) {
  const raw = String(format || DEFAULT_FORMAT).trim() || DEFAULT_FORMAT;
  const fields = raw.split('|').map(normalizeField);
  if (!fields.some(Boolean)) return DEFAULT_FORMAT.split('|').map(normalizeField);
  return fields;
}

function formatLabel(format) {
  return parseFormat(format).map((f) => {
    if (f === 'password') return 'pass';
    if (f === 'twoFa') return '2FA';
    if (f === 'passmail') return 'passmail';
    if (f === 'userAgent') return 'ua';
    return f || 'skip';
  }).join('|');
}

function splitLine(line) {
  return String(line).split('|').map((s) => s.trim());
}

function assignParts(fields, parts) {
  const values = {};
  if (parts.length <= fields.length) {
    fields.forEach((field, i) => {
      if (!field || field === 'skip') return;
      values[field] = parts[i] || '';
    });
    return values;
  }

  const cookieIdx = fields.indexOf('cookie');
  if (cookieIdx >= 0) {
    const extra = parts.length - fields.length;
    const merged = parts.slice();
    const taken = merged.splice(cookieIdx, extra + 1).join('|');
    merged.splice(cookieIdx, 0, taken);
    fields.forEach((field, i) => {
      if (!field || field === 'skip') return;
      values[field] = merged[i] || '';
    });
    return values;
  }

  fields.forEach((field, i) => {
    if (!field || field === 'skip') return;
    if (i === fields.length - 1) values[field] = parts.slice(i).join('|');
    else values[field] = parts[i] || '';
  });
  return values;
}

function parseLine(line, format) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  const fields = parseFormat(format);
  const parts = splitLine(trimmed);
  const values = assignParts(fields, parts);
  const cookie = values.cookie || '';
  const cookies = cookie ? parseCookieString(cookie) : [];
  const uid = values.uid || extractUid(cookie);
  if (!uid && !cookie && !values.password && !values.email) return null;
  return {
    uid,
    password: values.password || '',
    twoFa: values.twoFa || '',
    cookie,
    cookies,
    email: values.email || '',
    passmail: values.passmail || '',
    name: values.name || '',
    note: values.note || '',
    userAgent: values.userAgent || ''
  };
}

function parseBulk(text, format) {
  const rows = [];
  let skipped = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;
    const row = parseLine(line, format);
    if (row) rows.push(row);
    else skipped++;
  }
  const uniq = new Map();
  for (const row of rows) {
    const key = row.uid || `anon:${uniq.size}:${row.email || row.cookie.slice(0, 12)}`;
    uniq.set(key, row);
  }
  return { rows: [...uniq.values()], skipped };
}

function previewCount(text) {
  return String(text || '').split(/\r?\n/).filter((l) => {
    const line = l.trim();
    return line && !line.startsWith('#') && !line.startsWith('//');
  }).length;
}

module.exports = {
  DEFAULT_FORMAT,
  extractUid,
  cookieStringFromList,
  parseFormat,
  formatLabel,
  parseLine,
  parseBulk,
  previewCount
};
