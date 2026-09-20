const https = require('https');
const { isHarmlessCheckpointSrc, checkpointFromUrl } = require('./fburl');

function request(url, { method = 'GET', headers = {}, timeout = 15000, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
      timeout
    }, (res) => {
      const loc = res.headers.location;
      if (loc && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        const next = new URL(loc, url).toString();
        res.resume();
        return resolve(request(next, { method, headers, timeout, redirects: redirects - 1 }));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, url }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function cookieHeaders(cookie, userAgent) {
  return {
    cookie,
    'user-agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8'
  };
}

function titleOf(body) {
  const m = String(body || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

async function checkLive(account) {
  const cookie = account.cookie || '';
  if (!cookie) return { live: false, status: 'idle', error: 'Chưa có cookie' };

  const uidMatch = cookie.match(/c_user=(\d+)/);
  const uid = uidMatch ? uidMatch[1] : (account.uid || '');

  try {
    const headers = cookieHeaders(cookie, account.userAgent);
    const r = await request('https://mbasic.facebook.com/me', { headers });
    const body = String(r.body || '');
    const title = titleOf(body);
    const url = r.url || '';

    const cpInfo = checkpointFromUrl(url);
    const bodyLooksLocked = /checkpoint/i.test(body) && /(verify|locked|disabled|block)/i.test(body)
      && !isHarmlessCheckpointSrc(url);
    if (cpInfo || bodyLooksLocked) {
      const code = (cpInfo && cpInfo.code && cpInfo.code !== 'checkpoint') ? cpInfo.code : '';
      return { live: false, checkpoint: true, status: 'checkpoint', checkpointCode: code, name: '', uid };
    }

    const loggedOut = /login\.php|\/login/i.test(url)
      || /log\s?in|đăng nhập/i.test(title)
      || /name="email"/i.test(body);

    if (loggedOut) {
      return { live: false, status: 'dead', name: '', uid };
    }

    const name = title
      .replace(/\s*[|·].*$/, '')
      .replace(/\s*Facebook\s*$/i, '')
      .trim();

    return {
      live: true,
      status: 'live',
      name: name && name.toLowerCase() !== 'facebook' ? name : (account.name || ''),
      uid
    };
  } catch (err) {
    return { live: false, status: account.status || 'idle', error: String(err.message || err) };
  }
}

module.exports = { checkLive };
