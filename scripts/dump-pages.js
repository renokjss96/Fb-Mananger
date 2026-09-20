const path = require('path');
const Store = require('../src/store');
const { cookieHeader } = require('../src/exporter');
const { getManagedPages } = require('../src/pages');

const DATA = path.join(require('os').homedir(), 'AppData', 'Roaming', 'fb-manager', 'fb-manager-data.json');
const store = new Store(DATA);
store.load();

const accs = store.list();
const candidates = accs.filter(a => {
  const ck = a.cookie ? String(a.cookie) : cookieHeader(a);
  return ck && a.status !== 'checkpoint' && a.status !== 'running';
});
if (!candidates.length) {
  console.log('No usable account (all checkpoint/running or no cookie)');
  process.exit(0);
}
// prefer idle, then any
candidates.sort((a,b) => (a.status==='idle'?-1:1));
const a = candidates[0];
const ck = a.cookie ? String(a.cookie) : cookieHeader(a);
console.log('Spike account:', a.uid, 'status', a.status, 'cookie len', ck.length);

(async () => {
  try {
    const pages = await getManagedPages(ck);
    console.log('PAGES count:', pages.length);
    if (pages.length) {
      console.log('--- sample page object keys ---');
      console.log(Object.keys(pages[0]));
      console.log(JSON.stringify(pages[0], null, 2).slice(0, 3000));
    } else {
      console.log('No pages returned');
    }
    // also dump raw node keys by doing a raw fetch
    // Re-fetch tokens+graphql and show raw node
    console.log('\n--- raw graphql attempt ---');
    const fetchTokens = async (cookie) => {
      const res = await fetch('https://www.facebook.com/', {
        headers: { cookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36', 'accept': 'text/html' }
      });
      const html = await res.text();
      const keys = ['DTSG','lsd','jazoest'];
      console.log('html len', html.length, 'has dtsg', html.includes('DTSG'));
      return html.slice(0,500);
    };
    // just show pages sample is enough
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack && e.stack.slice(0, 2000));
  }
})();
