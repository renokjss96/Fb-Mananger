const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_FORMAT } = require('./importer');

const DEFAULTS = {
  chromePath: '',
  chromeEngine: 'bundled',
  batchDelay: 800,
  importFormat: DEFAULT_FORMAT,
  threads: 1,
  hideBrowser: false,
  agentEnabled: true
};

function clampThreads(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(20, Math.max(1, Math.floor(v)));
}

function normalizeEngine(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'system' || s === 'bundled') return s;
  return 'bundled';
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function emptyAccount(partial = {}) {
  return {
    id: newId(),
    uid: partial.uid || '',
    name: partial.name || '',
    alias: partial.alias || '',
    password: partial.password || '',
    twoFa: partial.twoFa || '',
    cookie: partial.cookie || '',
    cookies: Array.isArray(partial.cookies) ? partial.cookies : [],
    email: partial.email || '',
    passmail: partial.passmail || '',
    userAgent: partial.userAgent || '',
    status: partial.status || 'idle',
    checkpointCode: partial.checkpointCode || '',
    cookieDate: partial.cookieDate || (partial.cookie ? nowIso() : ''),
    lastCheck: partial.lastCheck || '',
    note: partial.note || '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { accounts: [], pages: [], settings: { ...DEFAULTS } };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed.accounts)) this.data.accounts = parsed.accounts.map(normalizeAccount);
      if (Array.isArray(parsed.pages)) this.data.pages = parsed.pages.map(normalizePage);
      else this.data.pages = [];
      if (parsed.settings) {
        this.data.settings = { ...DEFAULTS, ...parsed.settings };
        this.data.settings.threads = clampThreads(this.data.settings.threads);
        this.data.settings.hideBrowser = !!this.data.settings.hideBrowser;
        this.data.settings.chromeEngine = normalizeEngine(this.data.settings.chromeEngine);
        this.data.settings.agentEnabled = parsed.settings.agentEnabled !== false;
      }
    } catch (_) {
      /* empty store */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.file);
    } catch (_) {
      fs.copyFileSync(tmp, this.file);
      try { fs.unlinkSync(tmp); } catch (__) { /* ignore */ }
    }
  }

  list() {
    return this.data.accounts;
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id);
  }

  getByUid(uid) {
    const key = String(uid || '').trim();
    if (!key) return null;
    return this.data.accounts.find((a) => String(a.uid || '').trim() === key);
  }

  create(partial = {}) {
    const account = emptyAccount(partial);
    this.data.accounts.unshift(account);
    this.save();
    return account;
  }

  upsertRow(row) {
    const uid = row.uid || '';
    const existing = uid ? this.getByUid(uid) : null;
    const cookiePatch = {};
    if (row.cookie) {
      cookiePatch.cookie = row.cookie;
      cookiePatch.cookies = row.cookies || [];
      cookiePatch.cookieDate = nowIso();
    }
    if (existing) {
      Object.assign(existing, {
        password: row.password !== undefined && row.password !== '' ? row.password : existing.password,
        twoFa: row.twoFa !== undefined && row.twoFa !== '' ? row.twoFa : existing.twoFa,
        email: row.email !== undefined && row.email !== '' ? row.email : existing.email,
        passmail: row.passmail !== undefined && row.passmail !== '' ? row.passmail : existing.passmail,
        userAgent: row.userAgent || existing.userAgent,
        name: row.name || existing.name,
        note: row.note !== undefined && row.note !== '' ? row.note : existing.note,
        ...cookiePatch,
        updatedAt: nowIso()
      });
      this.save();
      return { account: existing, added: false };
    }
    const account = this.create({
      uid,
      name: row.name || '',
      password: row.password || '',
      twoFa: row.twoFa || '',
      cookie: row.cookie || '',
      cookies: row.cookies || [],
      email: row.email || '',
      passmail: row.passmail || '',
      userAgent: row.userAgent || '',
      note: row.note || '',
      status: 'idle'
    });
    return { account, added: true };
  }

  update(id, patch) {
    const a = this.get(id);
    if (!a) return null;
    Object.assign(a, patch, { updatedAt: nowIso() });
    this.save();
    return a;
  }

  remove(id) {
    const a = this.get(id);
    if (!a) return null;
    this.data.accounts = this.data.accounts.filter((x) => x.id !== id);
    this.save();
    return a;
  }

  removeMany(ids) {
    const set = new Set(ids || []);
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((x) => !set.has(x.id));
    this.save();
    return before - this.data.accounts.length;
  }

  getSettings() {
    return { ...this.data.settings };
  }

  setSettings(patch) {
    const next = { ...this.data.settings, ...patch };
    if (patch && 'threads' in patch) next.threads = clampThreads(patch.threads);
    if (patch && 'hideBrowser' in patch) next.hideBrowser = !!patch.hideBrowser;
    if (patch && 'chromeEngine' in patch) next.chromeEngine = normalizeEngine(patch.chromeEngine);
    if (patch && 'agentEnabled' in patch) next.agentEnabled = !!patch.agentEnabled;
    this.data.settings = next;
    this.save();
    return this.getSettings();
  }

  // ---- pages ----
  listPages() {
    if (!Array.isArray(this.data.pages)) this.data.pages = [];
    return this.data.pages;
  }

  getPage(pageId) {
    const key = String(pageId || '').trim();
    if (!key) return null;
    return this.listPages().find((p) => String(p.pageId) === key) || null;
  }

  upsertPages(pageRows) {
    if (!Array.isArray(this.data.pages)) this.data.pages = [];
    let added = 0;
    let updated = 0;
    for (const row of pageRows || []) {
      const pid = String(row.pageId || row.id || '').trim();
      if (!pid) continue;
      const existing = this.getPage(pid);
      const patch = {
        pageId: pid,
        name: row.name || (existing ? existing.name : ''),
        url: row.url || (existing ? existing.url : ''),
        category: row.category || (existing ? existing.category : ''),
        avatar: row.avatar || (existing ? existing.avatar : ''),
        ownerId: row.ownerId || (existing ? existing.ownerId : ''),
        ownerUid: row.ownerUid || (existing ? existing.ownerUid : ''),
        fan_count: row.fan_count != null ? row.fan_count : (existing ? existing.fan_count : null),
        followers_count: row.followers_count != null ? row.followers_count : (existing ? existing.followers_count : null),
        is_published: row.is_published != null ? !!row.is_published : (existing ? existing.is_published : null),
        page_access_token: row.page_access_token || (existing ? existing.page_access_token : ''),
        country_list: Array.isArray(row.country_list) ? row.country_list : (existing ? existing.country_list : []),
        is_blocklist: row.is_blocklist != null ? !!row.is_blocklist : (existing ? !!existing.is_blocklist : false),
        restrictionStatus: row.restrictionStatus || (existing ? existing.restrictionStatus : 'none'),
        updatedAt: nowIso(),
      };
      if (!patch.name && existing) patch.name = existing.name;
      if (existing) {
        Object.assign(existing, patch);
        updated++;
      } else {
        this.data.pages.push({ id: newId(), ...patch, createdAt: nowIso() });
        added++;
      }
    }
    if (added || updated) this.save();
    return { added, updated, total: this.data.pages.length };
  }

  updatePageRestriction(pageId, countryList, isBlocklist) {
    const p = this.getPage(pageId);
    if (!p) return null;
    const list = Array.isArray(countryList) ? countryList.map((s) => String(s).trim().toUpperCase()).filter(Boolean) : [];
    p.country_list = list;
    p.is_blocklist = !!isBlocklist;
    if (!list.length) p.restrictionStatus = 'none';
    else p.restrictionStatus = p.is_blocklist ? 'block' : 'allow';
    p.updatedAt = nowIso();
    this.save();
    return p;
  }

  removePages(pageIds) {
    const set = new Set((pageIds || []).map((x) => String(x).trim()));
    const before = this.listPages().length;
    this.data.pages = this.listPages().filter((p) => !set.has(String(p.pageId)) && !set.has(String(p.id)));
    this.save();
    return before - this.data.pages.length;
  }

  clearPagesByOwner(ownerId) {
    const key = String(ownerId || '').trim();
    if (!key) return 0;
    const before = this.listPages().length;
    this.data.pages = this.listPages().filter((p) => String(p.ownerId) !== key);
    this.save();
    return before - this.data.pages.length;
  }
}

function normalizeAccount(a) {
  return {
    id: a.id,
    uid: a.uid || '',
    name: a.name || '',
    alias: a.alias || '',
    password: a.password || '',
    twoFa: a.twoFa || '',
    cookie: a.cookie || '',
    cookies: Array.isArray(a.cookies) ? a.cookies : [],
    email: a.email || '',
    passmail: a.passmail || '',
    userAgent: a.userAgent || '',
    status: a.status || 'idle',
    checkpointCode: a.checkpointCode || '',
    cookieDate: a.cookieDate || '',
    lastCheck: a.lastCheck || '',
    note: a.note || '',
    createdAt: a.createdAt || nowIso(),
    updatedAt: a.updatedAt || nowIso()
  };
}

function normalizePage(p) {
  const list = Array.isArray(p.country_list) ? p.country_list : [];
  return {
    id: p.id || newId(),
    pageId: String(p.pageId || p.id || '').trim(),
    name: p.name || '',
    url: p.url || '',
    category: p.category || '',
    avatar: p.avatar || '',
    ownerId: p.ownerId || '',
    ownerUid: p.ownerUid || '',
    fan_count: p.fan_count != null ? p.fan_count : null,
    followers_count: p.followers_count != null ? p.followers_count : null,
    is_published: p.is_published != null ? !!p.is_published : null,
    page_access_token: p.page_access_token || '',
    country_list: list.map((s) => String(s).trim().toUpperCase()).filter(Boolean),
    is_blocklist: !!p.is_blocklist,
    restrictionStatus: p.restrictionStatus || (!list.length ? 'none' : (p.is_blocklist ? 'block' : 'allow')),
    createdAt: p.createdAt || nowIso(),
    updatedAt: p.updatedAt || nowIso()
  };
}

module.exports = Store;
