const { cookieHeader } = require('./exporter');

// ===== Graph API path (port từ momxgroup/fb-tool) =====
const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v20.0';

const DOC_PAGES = '7710553450524514'; // CometAllPagesListForUser_FullListRefetchQuery
const DOC_RESTRICT = '9629790297112029'; // CountryRestrictionSettingMutation

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
  const fields = 'id,name,category,fan_count,followers_count,picture,is_published,access_token';
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
    name: p.name || '',
    url: p.id ? `https://facebook.com/${p.id}` : '',
    category: p.category || '',
    avatar: p.picture?.data?.url || p.picture || '',
    fan_count: typeof p.fan_count === 'number' ? p.fan_count : null,
    followers_count: typeof p.followers_count === 'number' ? p.followers_count : null,
    is_published: typeof p.is_published === 'boolean' ? p.is_published : null,
    page_access_token: p.access_token || '',
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
  return { dtsg, lsd, jazoest, rev, hsi };
}

async function fetchTokens(cookie) {
  const res = await fetch('https://www.facebook.com/', {
    headers: {
      cookie,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
    },
  });
  const html = await res.text();
  const t = parseTokens(html);
  if (!t.dtsg) throw new Error('Không lấy được fb_dtsg - cookie hết hạn hoặc checkpoint');
  if (!t.lsd) throw new Error('Không lấy được lsd');
  return t;
}

async function graphQL(cookie, tokens, docId, friendlyName, variables) {
  const uid = uidFromCookie(cookie) || '0';
  const body = new URLSearchParams({
    av: uid,
    __user: uid,
    __a: '1',
    fb_dtsg: tokens.dtsg,
    lsd: tokens.lsd,
    jazoest: tokens.jazoest,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: friendlyName,
    variables: JSON.stringify(variables),
    doc_id: docId,
    server_timestamps: 'true',
  });
  const res = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': friendlyName,
      'x-fb-lsd': tokens.lsd,
      origin: 'https://www.facebook.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('GraphQL trả về không phải JSON: ' + text.slice(0, 400)); }
  if (json.errors) throw new Error(json.errors[0]?.message || JSON.stringify(json.errors).slice(0, 500));
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
  const tokens = await fetchTokens(cookie);
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

async function setCountryRestriction(cookie, pageId, countryList, isBlocklist) {
  const list = (Array.isArray(countryList) ? countryList : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const tokens = await fetchTokens(cookie);
  const variables = {
    input: {
      country_list: list,
      is_blocklist: !!isBlocklist,
      actor_id: String(pageId),
      client_mutation_id: '1',
    },
  };
  const json = await graphQL(cookie, tokens, DOC_RESTRICT, 'CountryRestrictionSettingMutation', variables);
  const payload = json?.data?.country_restriction_setting_update || json?.data?.update_country_restriction || null;
  if (json.errors) throw new Error(json.errors[0].message);
  return { ok: true, payload, country_list: list, is_blocklist: !!isBlocklist };
}

async function scanForAccounts(accounts, onProgress) {
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

module.exports = { getManagedPages, getManagedPagesViaGraphQL, getFreshAccessTokenFromCookies, getUserPagesViaGraph, setCountryRestriction, scanForAccounts, uidFromCookie };
