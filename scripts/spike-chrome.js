const path = require('path');
const fs = require('fs');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const Store = require('../src/store');
const { toCdpCookies } = require('../src/exporter');
const { findBundledChrome, bundledChromedriver, detectChromium } = require('../src/detect');

async function resolveChrome() {
  let p = findBundledChrome();
  if (p) return { exe: p, driverBin: bundledChromedriver() };
  const d = detectChromium();
  if (d) return { exe: d.path, driverBin: '' };
  throw new Error('Không tìm thấy Chrome');
}

function dataFile() {
  const homedir = require('os').homedir();
  return path.join(homedir, 'AppData', 'Roaming', 'fb-manager', 'fb-manager-data.json');
}

async function main() {
  const store = new Store(dataFile());
  store.load();
  const all = store.list();
  console.log('accounts:', all.map(a => `${a.uid} status=${a.status} ck=${(a.cookie||'').length}`).join(' | '));

  // pick first with cookie and not obviously dead - prefer idle with longest cookie
  let candidates = all.filter(a => (a.cookie||'').length > 100);
  // try idle first, then any
  candidates.sort((a,b) => {
    const rank = s => s==='idle'?0 : s==='live'?1 : 2;
    return rank(a.status)-rank(b.status) || (b.cookie.length - a.cookie.length);
  });
  if (!candidates.length) { console.log('No candidate'); return; }
  const acc = candidates[0];
  console.log('Pick:', acc.uid, 'status', acc.status, 'ck', acc.cookie.length);

  const { exe, driverBin } = await resolveChrome();
  console.log('Chrome:', exe.slice(-60), 'driverBin:', driverBin ? driverBin.slice(-40) : '(selenium-manager)');

  const profileDir = path.join(require('os').tmpdir(), 'fb-spike-' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });

  const opts = new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  // headless
  opts.addArguments('--headless=new', '--disable-gpu', '--window-size=1280,900');

  const svc = driverBin ? new chrome.ServiceBuilder(driverBin) : null;
  let builder = new Builder().forBrowser('chrome').setChromeOptions(opts);
  if (svc) builder = builder.setChromeService(svc);
  if (!driverBin) {
    const mng = path.join(path.dirname(require.resolve('selenium-webdriver/package.json')), 'bin', 'windows', 'selenium-manager.exe');
    if (fs.existsSync(mng)) process.env.SE_MANAGER_PATH = mng;
  } else {
    process.env.SE_CHROMEDRIVER = driverBin;
  }

  const driver = await builder.build();
  try {
    console.log('Driver started, injecting cookies...');
    await driver.get('https://www.facebook.com/');
    await driver.sleep(1500);

    const cookies = toCdpCookies(acc);
    console.log('CDP cookies:', cookies.length, cookies.map(c=>c.name).slice(0,8).join(','));
    for (const c of cookies) {
      const payload = { name: c.name, value: String(c.value), domain: c.domain || '.facebook.com', path: c.path||'/', secure: c.secure!==false, httpOnly: !!c.httpOnly };
      if (c.expires && c.expires>0) payload.expiry = Math.floor(c.expires);
      try { await driver.manage().addCookie(payload); } catch (e) {
        try { payload.domain='facebook.com'; await driver.manage().addCookie(payload);} catch(_){}
      }
    }
    console.log('Cookies added, reloading...');
    await driver.get('https://www.facebook.com/');
    await driver.sleep(3500);

    const url = await driver.getCurrentUrl();
    console.log('URL after reload:', url.slice(0,180));

    // Check if still login page
    const htmlLen = await driver.executeScript('return document.documentElement.outerHTML.length');
    console.log('HTML len:', htmlLen);

    const hasEmail = await driver.findElements(By.id('email')).then(a=>a.length);
    console.log('has #email (login page):', hasEmail);

    // Try to extract DTSG/LSD/tokens from page source via JS
    const tokens = await driver.executeScript(`
      const html = document.documentElement.outerHTML;
      function m(re){ const x=html.match(re); return x?x[1]:''; }
      return {
        dtsg: m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || m(/name="fb_dtsg" value="([^"]+)"/),
        lsd: m(/"LSD"[^}]*"token":"([^"]+)"/),
        hsi: m(/"hsi":"([^"]+)"/),
        rev: m(/"client_revision":(\\d+)/),
        htmlSlice: html.slice(0,2500)
      };
    `);
    console.log('Tokens found: dtsg', !!tokens.dtsg, 'lsd', !!tokens.lsd, 'hsi', !!tokens.hsi, 'rev', tokens.rev||'');
    if (!tokens.dtsg) {
      console.log('No DTSG — page slice:');
      console.log(tokens.htmlSlice.replace(/\n/g,' ').slice(0,2000));
      // save screenshot source length already shown
      return;
    }

    // Now call GraphQL from inside browser (same origin, cookies already set)
    const result = await driver.executeAsyncScript(`
      const cb = arguments[arguments.length-1];
      (async () => {
        try {
          const html = document.documentElement.outerHTML;
          function m(re){ const x=html.match(re); return x?x[1]:''; }
          const dtsg = m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || m(/name="fb_dtsg" value="([^"]+)"/) || '';
          const lsd = m(/"LSD"[^}]*"token":"([^"]+)"/) || '';
          const jazoest = (html.match(/jazoest=(\\d+)/)||[])[1] || '25537';
          const rev = (html.match(/"client_revision":(\\d+)/)||[])[1] || '1047982283';
          const hsi = m(/"hsi":"([^"]+)"/) || '';
          const ck = document.cookie;
          const uid = (ck.match(/c_user=(\\d+)/)||[])[1] || '0';
          // Try the doc id from src/pages.js
          const docId = '7710553450524514';
          const friendly = 'CometAllPagesListForUser_FullListRefetchQuery';
          const body = new URLSearchParams({
            av: uid, __user: uid, __a: '1',
            fb_dtsg: dtsg, lsd: lsd, jazoest: jazoest,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: friendly,
            variables: JSON.stringify({ count: 5 }),
            doc_id: docId, server_timestamps: 'true'
          });
          const res = await fetch('https://www.facebook.com/api/graphql/', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': friendly, 'x-fb-lsd': lsd, 'origin': 'https://www.facebook.com' },
            body: body.toString(), credentials: 'include'
          });
          const text = await res.text();
          let json; try{ json = JSON.parse(text);}catch(e){ return cb({ ok:false, error: 'not json', text: text.slice(0,3000) }); }
          if (json.errors) return cb({ ok:false, error: json.errors[0]?.message || JSON.stringify(json.errors).slice(0,1000), text: text.slice(0,2000) });
          // extract edges
          const candidates = [json?.data?.viewer?.pages?.edges, json?.data?.viewer?.actor?.pages?.edges, json?.data?.me?.pages?.edges];
          let edges = null;
          for (const c of candidates) if (Array.isArray(c)) { edges=c; break; }
          if (!edges) {
            // fallback: find any key with edges
            const str = JSON.stringify(json).slice(0,8000);
            return cb({ ok:true, found:0, jsonKeys: Object.keys(json?.data||{}), str });
          }
          const sample = edges[0]?.node || null;
          return cb({ ok:true, found: edges.length, sampleKeys: sample?Object.keys(sample):[], sample: sample, rawKeys: json?.data?Object.keys(json.data):[] });
        } catch(e){ cb({ ok:false, error: String(e.message||e) }); }
      })();
    `);
    console.log('GraphQL result:', JSON.stringify(result, null, 2).slice(0, 6000));
    if (result && result.sample) {
      console.log('--- sample node pretty ---');
      console.log(JSON.stringify(result.sample, null, 2).slice(0, 6000));
    }

  } finally {
    try { await driver.quit(); } catch(_){}
    try { fs.rmSync(profileDir, { recursive:true, force:true }); } catch(_){}
    console.log('Done.');
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
