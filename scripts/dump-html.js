const path = require('path');
const Store = require('../src/store');
const { cookieHeader } = require('../src/exporter');

const DATA = path.join(require('os').homedir(), 'AppData', 'Roaming', 'fb-manager', 'fb-manager-data.json');
const store = new Store(DATA);
store.load();
const a = store.list().find(x=>x.uid==='100095437232993');
const ck = (a.cookie && String(a.cookie).trim()) ? String(a.cookie) : cookieHeader(a);
console.log('cookie hasCUser', /c_user=/.test(ck), 'len', ck.length);
console.log('cookie c_user=', ck.match(/c_user=(\d+)/)?.[1]);

(async()=>{
  const res = await fetch('https://www.facebook.com/', {
    headers: {
      cookie: ck,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'vi,en;q=0.9',
    },
    redirect: 'manual'
  });
  console.log('status', res.status, res.headers.get('location')||'');
  const html = await res.text();
  console.log('html len', html.length);
  console.log(html.slice(0, 2000).replace(/\n/g,' '));
  console.log('--- search markers ---');
  console.log('has DTSG', html.includes('DTSG'));
  console.log('has checkpoint', html.toLowerCase().includes('checkpoint'));
  console.log('has login', html.toLowerCase().includes('login'));
})();
