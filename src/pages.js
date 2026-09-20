const { cookieHeader } = require('./exporter');

// ===== Graph API path (port từ momxgroup/fb-tool) =====
const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v20.0';

const DOC_PAGES = '7710553450524514'; // CometAllPagesListForUser_FullListRefetchQuery
const DOC_RESTRICT = '9629790297112029'; // CountryRestrictionSettingMutation
const DOC_AVATAR = '27326177573748994'; // ProfileCometProfilePictureSetMutation

function uidFromCookie(cookie) {
  const m = String(cookie || '').match(/c_user=(\d+)/);
  return m ? m[1] : '';
}

// ---- fb-tool: find AdsCanvasConfig helper ----
function findAdsCanvasConfig(obj) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (Array.isArray(item) && item[0] === 'AdsCanvasConfig') return item;
      const found = findAdsCanvasConfig(item);
      if (found) return found;
    }
  } else if (obj && typeof obj === 'object') {
    for (const k in obj) {
      const found = findAdsCanvasConfig(obj[k]);
      if (found) return found;
    }
  }
  return null;
}

async function getFreshAccessTokenFromCookies(cookie) {
  // Port y hệt fb-tool: GET bootloader endpoint với Cookie header.
  // Node fetch bị chặn nếu thiếu header browser → thử 2 lần với header đầy đủ.
  const urls = [
    'https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1',
    'https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1&__user=0',
  ];
  let lastErr = null;
  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        cookie: String(cookie || ''),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9,vi;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      },
    });
    const raw = await res.text();
    // FB trả "for (;;);{...}" — bỏ prefix rồi parse
    let text = raw.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      lastErr = new Error('Không parse được bootloader response: ' + raw.slice(0, 400));
      continue;
    }
    // Nếu FB trả error payload (như 1357005 khi thiếu header), throw để thử URL khác
    if (parsed && parsed.error) {
      lastErr = new Error(`bootloader error ${parsed.error}: ${parsed.errorSummary || ''} ${parsed.errorDescription || ''}`.slice(0, 500));
      continue;
    }
    const cfg = findAdsCanvasConfig(parsed);
    if (!cfg || !cfg[2] || !cfg[2].access_token) {
      lastErr = new Error('Không lấy được access_token từ AdsCanvasConfig (len ' + raw.length + ')');
      continue;
    }
    return String(cfg[2].access_token);
  }
  throw lastErr || new Error('Không lấy được access_token từ AdsCanvasConfig');
}

async function getUserPagesViaGraph(cookie, accessToken) {
  // fb-tool lấy thêm additional_profile_id — chính là actor_id dạng 615... cho mutation
  const fields = 'id,name,category,fan_count,followers_count,picture,is_published,access_token,additional_profile_id';
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    headers: {
      cookie: String(cookie || ''),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      accept: 'application/json',
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Graph API trả về không phải JSON: ' + text.slice(0, 400)); }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error).slice(0, 500));
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map((p) => ({
    pageId: String(p.id || ''),
    actorId: String(p.additional_profile_id || p.id || ''),
    name: p.name || '',
    url: p.id ? `https://facebook.com/${p.id}` : '',
    category: p.category || '',
    avatar: p.picture?.data?.url || p.picture || '',
    fan_count: typeof p.fan_count === 'number' ? p.fan_count : null,
    followers_count: typeof p.followers_count === 'number' ? p.followers_count : null,
    is_published: typeof p.is_published === 'boolean' ? p.is_published : null,
    page_access_token: p.access_token || '',
    additional_profile_id: p.additional_profile_id ? String(p.additional_profile_id) : '',
  })).filter((p) => p.pageId);
}

function parseTokens(html) {
  const dtsg = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1]
    || html.match(/"DTSGInitialData"[^}]*"token":"([^"]+)"/)?.[1]
    || html.match(/fb_dtsg":"([^"]+)"/)?.[1]
    || html.match(/name="fb_dtsg" value="([^"]+)"/)?.[1]
    || '';
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] || '';
  const jazoest = html.match(/jazoest=(\d+)/)?.[1] || '25537';
  const rev = html.match(/"client_revision":(\d+)/)?.[1] || '1047982283';
  const hsi = html.match(/"hsi":"([^"]+)"/)?.[1] || '';
  const s = html.match(/"__s":"([^"]+)"/)?.[1] || html.match(/__s["']\s*[:=]\s*["']([^"']+)["']/)?.[1] || '';
  const dyn = html.match(/"__dyn":"([^"]+)"/)?.[1] || '';
  const csr = html.match(/"__csr":"([^"]+)"/)?.[1] || '';
  const hsdp = html.match(/"__hsdp":"([^"]+)"/)?.[1] || '';
  return { dtsg, lsd, jazoest, rev, hsi, s, dyn, csr, hsdp };
}

async function fetchTokens(cookie) {
  // Node fetch với Chrome 153 UA bị FB trả 400 "Sorry..." — thử minimal headers trước
  // A/B test trên máy thật: no-UA -> 200 hasDTSG true, UA Chrome153 -> 400
  const tries = [
    { cookie, accept: 'text/html,application/xhtml+xml', 'accept-language': 'vi,en;q=0.9' },
    { cookie, 'user-agent': 'Mozilla/5.0', accept: 'text/html,application/xhtml+xml' },
  ];
  let lastHtml = '';
  for (const headers of tries) {
    const res = await fetch('https://www.facebook.com/', { headers });
    const html = await res.text();
    lastHtml = html;
    const t = parseTokens(html);
    if (t.dtsg && t.lsd) return t;
  }
  const t = parseTokens(lastHtml);
  if (!t.dtsg) throw new Error('Không lấy được fb_dtsg - cookie hết hạn hoặc checkpoint');
  if (!t.lsd) throw new Error('Không lấy được lsd');
  return t;
}

async function fetchTokensSmart(cookie) { return fetchTokens(cookie); }

function getLogFilePath() {
  const path = require('path');
  const os = require('os');
  // Ưu tiên cùng chỗ với fb-manager-data.json (như main.js:resolveDataRoot)
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const userData = app.getPath('userData');
      if (userData) return path.join(userData, 'country-restrict.log');
    }
  } catch (_) {}
  // Thử portable data/
  try {
    const fs = require('fs');
    const candidates = [
      path.join(__dirname, '..', 'data'),
      path.join(path.dirname(process.execPath || ''), 'data'),
    ];
    for (const c of candidates) {
      try { fs.mkdirSync(c, { recursive: true }); const probe = path.join(c, '.write-test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return path.join(c, 'country-restrict.log'); } catch (_) {}
    }
  } catch (_) {}
  return path.join(os.homedir(), 'AppData', 'Roaming', 'fb-manager', 'country-restrict.log');
}
function appendRestrictLog(obj) {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = getLogFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`;
    fs.appendFileSync(file, line, 'utf8');
  } catch (_) {}
}

function ensureIUserCookie(cookie, actorId) {
  const c = String(cookie || '');
  if (/i_user=/.test(c)) return c;
  if (!actorId) return c;
  return c + (c.endsWith(';') ? ' ' : '; ') + `i_user=${actorId}`;
}

async function graphQL(cookie, tokens, docId, friendlyName, variables) {
  const uid = uidFromCookie(cookie) || '0';
  let av = uid;
  try {
    const actorFromVars = variables && variables.input && variables.input.actor_id;
    if (actorFromVars) av = String(actorFromVars);
  } catch (_) {}
  // Cookie phải có i_user=actorId như curl của anh mới pass 1357032
  const cookieWithIUser = ensureIUserCookie(cookie, av);
  // Tối giản như curl Postman của anh — chỉ những field thực sự cần
  const body = new URLSearchParams({
    av,
    __user: av,
    fb_dtsg: tokens.dtsg,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: friendlyName,
    server_timestamps: 'true',
    variables: JSON.stringify(variables),
    doc_id: docId,
  });
  const bodyStr = body.toString();
  const reqLog = { kind: 'graphql_req', friendlyName, docId, av, actor_id: (variables && variables.input && variables.input.actor_id) || '', country_list: (variables && variables.input && variables.input.country_list) || [], is_blocklist: variables && variables.input && variables.input.is_blocklist, c_user: uid, dtsg: String(tokens.dtsg || '').slice(0, 24) + '...', lsd: tokens.lsd, cookie_has_i_user: /i_user=/.test(cookieWithIUser), body: bodyStr.slice(0, 1200) };
  appendRestrictLog(reqLog);
  const res = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: {
      cookie: cookieWithIUser,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': friendlyName,
      'x-fb-lsd': tokens.lsd,
      origin: 'https://www.facebook.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-asbd-id': '359341',
    },
    body,
  });
  let text = await res.text();
  const rawText = text;
  text = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
  let json;
  try { json = JSON.parse(text); } catch { appendRestrictLog({ kind: 'graphql_res', friendlyName, docId, status: res.status, raw: rawText.slice(0, 2000) }); throw new Error('GraphQL trả về không phải JSON: ' + text.slice(0, 600)); }
  appendRestrictLog({ kind: 'graphql_res', friendlyName, docId, status: res.status, json: JSON.stringify(json).slice(0, 3000) });
  if (json && json.error) {
    const msg = json.errorSummary || json.errorDescription || `FB error ${json.error} ${json.errorDescription || ''}`;
    throw new Error(String(msg).slice(0, 600) || `FB error ${json.error}`);
  }
  if (json.errors) throw new Error(json.errors[0]?.message || JSON.stringify(json.errors).slice(0, 600));
  return json;
}

function extractPages(json) {
  // Try several paths FB may return
  const candidates = [
    json?.data?.viewer?.pages?.edges,
    json?.data?.viewer?.actor?.pages?.edges,
    json?.data?.me?.pages?.edges,
  ];
  for (const e of candidates) if (Array.isArray(e)) return e;
  // Fallback: search any edges with node.id
  return [];
}

async function getManagedPagesViaGraphQL(cookie) {
  const tokens = await fetchTokensSmart(cookie);
  const json = await graphQL(cookie, tokens, DOC_PAGES, 'CometAllPagesListForUser_FullListRefetchQuery', { count: 100 });
  const edges = extractPages(json);
  return edges.map((e) => {
    const n = e.node || {};
    return {
      pageId: String(n.id || ''),
      name: n.name || '',
      url: n.url || (n.id ? `https://facebook.com/${n.id}` : ''),
      category: n.category_name || n.category || '',
      avatar: n.profile_picture?.uri || n.profilePicLarge?.uri || '',
    };
  }).filter((p) => p.pageId);
}

async function getManagedPages(cookie) {
  // Ưu tiên Graph API (bền, có fan_count/is_published) — fallback sang doc_id cũ
  try {
    const token = await getFreshAccessTokenFromCookies(cookie);
    const pages = await getUserPagesViaGraph(cookie, token);
    if (pages.length) return pages;
    // nếu Graph trả rỗng nhưng không lỗi, thử fallback
  } catch (e) {
    // Graph path fail (token hết hạn, checkpoint...) — thử doc_id cũ để giữ tương thích
    const msg = String(e.message || e);
    if (/AdsCanvasConfig|access_token|Graph API/i.test(msg)) {
      // lỗi Graph — fallback
    } else {
      // lỗi khác vẫn fallback
    }
  }
  return getManagedPagesViaGraphQL(cookie);
}

async function resolveActorId(cookie, pageId) {
  // Ưu tiên additional_profile_id từ me/accounts (dạng 6159...), chính là av/actor_id thực trong curl
  try {
    const tok = await getFreshAccessTokenFromCookies(cookie);
    const pages = await getUserPagesViaGraph(cookie, tok);
    const hit = pages.find((p) => String(p.pageId) === String(pageId));
    if (hit && hit.actorId && String(hit.actorId) !== String(pageId)) return String(hit.actorId);
    if (hit && hit.additional_profile_id) return String(hit.additional_profile_id);
  } catch (_) {}
  return String(pageId);
}

async function setCountryRestriction(cookie, pageId, countryList, isBlocklist) {
  const list = (Array.isArray(countryList) ? countryList : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const actorId = await resolveActorId(cookie, pageId);
  const tokens = await fetchTokensSmart(cookie);
  const variables = {
    input: {
      country_list: list,
      is_blocklist: !!isBlocklist,
      actor_id: actorId,
      client_mutation_id: '1',
    },
  };
  const json = await graphQL(cookie, tokens, DOC_RESTRICT, 'CountryRestrictionSettingMutation', variables);
  const payload = json?.data?.country_restriction_setting_update || json?.data?.update_country_restriction || null;
  if (json.errors) throw new Error(json.errors[0].message);
  return { ok: true, payload, country_list: list, is_blocklist: !!isBlocklist };
}

async function scanForAccounts(accounts, onProgress, store) {
  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const cookie = a.cookie ? String(a.cookie) : cookieHeader(a);
    if (!cookie) {
      onProgress && onProgress({ index: i, total: accounts.length, uid: a.uid, error: 'no cookie' });
      continue;
    }
    try {
      const pages = await getManagedPages(cookie);
      // Cache dtsg/lsd for later setCountryRestriction to avoid refetch + avoid expiry
      if (store && typeof store.setOwnerTokens === 'function') {
        try {
          const tokens = await fetchTokensSmart(cookie);
          store.setOwnerTokens(a.id, { dtsg: tokens.dtsg, lsd: tokens.lsd, jazoest: tokens.jazoest, rev: tokens.rev, hsi: tokens.hsi, s: tokens.s, dyn: tokens.dyn, csr: tokens.csr, hsdp: tokens.hsdp });
        } catch (_) { /* ignore token cache fail */ }
      }
      for (const p of pages) {
        results.push({
          ...p,
          ownerId: a.id,
          ownerUid: a.uid || uidFromCookie(cookie),
          country_list: [],
          is_blocklist: false,
          restrictionStatus: 'none',
        });
      }
      onProgress && onProgress({ index: i, total: accounts.length, uid: a.uid, count: pages.length });
    } catch (e) {
      onProgress && onProgress({ index: i, total: accounts.length, uid: a.uid, error: String(e.message || e) });
    }
  }
  // dedup by pageId, keep first owner
  const seen = new Map();
  for (const p of results) {
    if (!seen.has(p.pageId)) seen.set(p.pageId, p);
  }
  return [...seen.values()];
}

async function setCountryRestrictionWithCache(cookie, pageId, countryList, isBlocklist, cachedTokens, store) {
  const list = (Array.isArray(countryList) ? countryList : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  // Ưu tiên actorId dạng 615... từ store (đã lưu khi quét), không thì resolve qua Graph
  let actorId = String(pageId);
  if (store && typeof store.getPage === 'function') {
    try {
      const p = store.getPage(pageId);
      if (p && p.actorId) actorId = String(p.actorId);
      else if (p && p.additional_profile_id) actorId = String(p.additional_profile_id);
    } catch (_) {}
  }
  if (actorId === String(pageId)) {
    try { actorId = await resolveActorId(cookie, pageId); } catch (_) {}
  }
  let tokens = cachedTokens && cachedTokens.dtsg && cachedTokens.lsd ? cachedTokens : null;
  if (!tokens) tokens = await fetchTokensSmart(cookie);
  const variables = {
    input: {
      country_list: list,
      is_blocklist: !!isBlocklist,
      actor_id: actorId,
      client_mutation_id: '1',
    },
  };
  try {
    const json = await graphQL(cookie, tokens, DOC_RESTRICT, 'CountryRestrictionSettingMutation', variables);
    const payload = json?.data?.country_restriction_setting_update || json?.data?.update_country_restriction || null;
    if (json.errors) throw new Error(json.errors[0].message);
    return { ok: true, payload, country_list: list, is_blocklist: !!isBlocklist };
  } catch (e) {
    const msg = String(e.message || '');
    if (/Đã xảy ra lỗi|1357032|1357/i.test(msg)) throw e;
    if (/fb_dtsg|DTSG|lsd/i.test(msg)) {
      const fresh = await fetchTokensSmart(cookie);
      const json2 = await graphQL(cookie, fresh, DOC_RESTRICT, 'CountryRestrictionSettingMutation', variables);
      const payload2 = json2?.data?.country_restriction_setting_update || json2?.data?.update_country_restriction || null;
      if (json2.errors) throw new Error(json2.errors[0].message);
      return { ok: true, payload: payload2, country_list: list, is_blocklist: !!isBlocklist, freshTokens: fresh };
    }
    throw e;
  }
}

// ===== Avatar: upload file -> ProfileCometProfilePictureSetMutation =====
async function uploadPageAvatar(cookie, actorId, filePath, tokens) {
  const fs = require('fs');
  const path = require('path');
  if (!fs.existsSync(filePath)) throw new Error('Không tìm thấy file ảnh: ' + filePath);
  const t = tokens || await fetchTokensSmart(cookie);
  const cookieWithIUser = ensureIUserCookie(cookie, actorId);
  const url = new URL('https://www.facebook.com/profile/picture/upload/');
  url.searchParams.set('photo_source', '57');
  url.searchParams.set('profile_id', String(actorId));
  url.searchParams.set('av', String(actorId));
  url.searchParams.set('__aaid', '0');
  url.searchParams.set('__user', String(actorId));
  url.searchParams.set('__a', '1');
  url.searchParams.set('__req', '1m');
  url.searchParams.set('__hs', '20716.HYP:comet_pkg.2.1...0');
  url.searchParams.set('dpr', '1');
  url.searchParams.set('__ccg', 'GOOD');
  url.searchParams.set('__rev', String(t.rev || '1047985973'));
  url.searchParams.set('__s', String(t.s || ''));
  url.searchParams.set('__hsi', String(t.hsi || ''));
  url.searchParams.set('__dyn', String(t.dyn || ''));
  url.searchParams.set('__csr', String(t.csr || ''));
  url.searchParams.set('__hsdp', String(t.hsdp || ''));
  url.searchParams.set('__sjsp', '');
  url.searchParams.set('__comet_req', '15');
  url.searchParams.set('fb_dtsg', String(t.dtsg || ''));
  url.searchParams.set('jazoest', String(t.jazoest || ''));
  url.searchParams.set('lsd', String(t.lsd || ''));
  url.searchParams.set('__spin_r', String(t.rev || '1047985973'));
  url.searchParams.set('__spin_b', 'trunk');
  url.searchParams.set('__spin_t', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('__crn', 'comet.fbweb.CometProfileTimelineListViewRoute');
  const stat = fs.statSync(filePath);
  if (stat.size > 8 * 1024 * 1024) throw new Error('Ảnh quá lớn (>8MB)');
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const blob = new Blob([buf], { type: mime });
  const fd = new FormData();
  fd.append('file', blob, path.basename(filePath));
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      cookie: cookieWithIUser,
      'x-fb-lsd': String(t.lsd || ''),
      origin: 'https://www.facebook.com',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'x-asbd-id': '359341',
    },
    body: fd,
  });
  let text = await res.text();
  text = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Upload avatar không phải JSON: ' + text.slice(0, 600)); }
  if (json && json.error) throw new Error(json.errorSummary || json.errorDescription || `FB upload error ${json.error}`);
  if (json.errors) throw new Error(json.errors[0]?.message || JSON.stringify(json.errors).slice(0, 500));
  // FB trả fbid/photo_id ở nhiều dạng: payload.fbid, payload.photoID, data.fbid...
  const photoId = json?.payload?.fbid || json?.payload?.photoID || json?.payload?.photo_id || json?.fbid || json?.id || json?.payload?.id || null;
  // fallback: tìm số dài 15-20 chữ số
  let found = photoId ? String(photoId) : '';
  if (!found) {
    const m = text.match(/"fbid"\s*:\s*"(\d+)"/) || text.match(/"photo_id"\s*:\s*"(\d+)"/) || text.match(/"id"\s*:\s*"(\d{15,20})"/);
    if (m) found = m[1];
  }
  if (!found) throw new Error('Không lấy được photo_id sau upload: ' + text.slice(0, 800));
  return { photoId: String(found), raw: json };
}

async function setPageAvatar(cookie, pageId, filePath, cachedTokens, store) {
  let actorId = String(pageId);
  if (store && typeof store.getPage === 'function') {
    try { const p = store.getPage(pageId); if (p && p.actorId) actorId = String(p.actorId); else if (p && p.additional_profile_id) actorId = String(p.additional_profile_id); } catch (_) {}
  }
  if (actorId === String(pageId)) {
    try { actorId = await resolveActorId(cookie, pageId); } catch (_) {}
  }
  const tokens = cachedTokens && cachedTokens.dtsg ? cachedTokens : await fetchTokensSmart(cookie);
  const up = await uploadPageAvatar(cookie, actorId, filePath, tokens);
  const photoId = up.photoId;
  const variables = {
    input: {
      attribution_id_v2: `ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,tap_bookmark,${Date.now()},353802,${actorId},,`,
      caption: '',
      existing_photo_id: String(photoId),
      expiration_time: null,
      profile_id: String(actorId),
      profile_pic_method: 'EXISTING',
      profile_pic_source: 'TIMELINE',
      scaled_crop_rect: { height: 0.59782, width: 1, x: 0, y: 0.0058 },
      skip_cropping: true,
      actor_id: String(actorId),
      client_mutation_id: '2',
    },
    isPage: false,
    isProfile: true,
    scale: 1,
    __relay_internal__pv__ProfileGeminiIsCoinFlipEnabledrelayprovider: false,
  };
  const json = await graphQL(cookie, tokens, DOC_AVATAR, 'ProfileCometProfilePictureSetMutation', variables);
  return { ok: true, photoId, actorId, payload: json?.data || json };
}

module.exports = { getManagedPages, getManagedPagesViaGraphQL, getFreshAccessTokenFromCookies, getUserPagesViaGraph, fetchTokens, fetchTokensSmart, parseTokens, setCountryRestriction, setCountryRestrictionWithCache, uploadPageAvatar, setPageAvatar, scanForAccounts, uidFromCookie, resolveActorId, getLogFilePath };
