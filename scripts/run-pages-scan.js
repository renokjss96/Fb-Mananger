const path=require('path');
const Store=require('../src/store');
const {scanForAccounts}=require('../src/pages');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const store=new Store(DATA); store.load();
console.log('accounts',store.list().length, store.list().map(a=>a.uid+':'+a.status).join(' | '));
console.log('pages before', store.listPages().length);
(async()=>{
  const targets = store.list().filter(a=> a.cookie && String(a.cookie).trim());
  console.log('targets',targets.length, targets.map(a=>a.uid).join(','));
  const pages = await scanForAccounts(targets, ev=>{
    if(ev.error) console.log(`  [${ev.uid}] ERR ${ev.error.slice(0,180)}`);
    else console.log(`  [${ev.uid}] ${ev.count} page`);
  });
  console.log('scanned pages total', pages.length);
  if(pages.length){
    console.log(pages.slice(0,3).map(p=> `${p.pageId} ${p.name} fan=${p.fan_count} pub=${p.is_published} owner=${p.ownerUid}`).join('\n'));
  }
  const res = store.upsertPages(pages);
  console.log('upsert', res);
  console.log('pages after', store.listPages().length);
})();
