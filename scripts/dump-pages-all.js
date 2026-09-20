const path = require('path');
const Store = require('../src/store');
const { cookieHeader } = require('../src/exporter');
const { getManagedPages } = require('../src/pages');

const DATA = path.join(require('os').homedir(), 'AppData', 'Roaming', 'fb-manager', 'fb-manager-data.json');
const store = new Store(DATA);
store.load();

(async () => {
  for (const a of store.list()) {
    const ck = (a.cookie && String(a.cookie).trim()) ? String(a.cookie) : cookieHeader(a);
    const hasCUser = /c_user=/.test(ck);
    console.log(`\n=== ${a.uid} status=${a.status} ckLen=${ck.length} hasCUser=${hasCUser} ===`);
    if (!ck) { console.log('  skip: no cookie'); continue; }
    if (ck.length < 50) console.log('  cookie preview:', ck.slice(0,120));
    try {
      const pages = await getManagedPages(ck);
      console.log(`  OK pages=${pages.length}`);
      if (pages.length) {
        console.log('  keys:', Object.keys(pages[0]));
        console.log(JSON.stringify(pages[0], null, 2).slice(0, 2000));
      }
    } catch (e) {
      console.log('  FAIL:', e.message.slice(0,300));
    }
  }
})();
