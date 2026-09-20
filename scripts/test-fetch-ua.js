const path=require('path');
const Store=require('../src/store');
const {cookieHeader}=require('../src/exporter');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const s=new Store(DATA); s.load();
const acc=s.list().find(a=>a.uid==='100058089476414');
const ck=acc.cookie||cookieHeader(acc);

async function tryFetch(label, headers){
  const res=await fetch('https://www.facebook.com/',{headers});
  const h=await res.text();
  console.log(`[${label}] status ${res.status} len ${h.length} hasDTSG ${h.includes('DTSG')} snippet ${h.slice(0,220).replace(/\n/g,' ').slice(0,220)}`);
}

(async()=>{
  console.log('ck len',ck.length);
  await tryFetch('A no UA', {cookie: ck});
  await tryFetch('B UA only', {cookie: ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'});
  await tryFetch('C UA+accept', {cookie: ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','accept':'text/html,application/xhtml+xml'});
  await tryFetch('D full browser headers', {cookie: ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','accept':'text/html,application/xhtml+xml','accept-language':'en-US,en;q=0.9,vi;q=0.8','sec-fetch-site':'same-origin','sec-fetch-mode':'navigate','sec-fetch-user':'?1','cache-control':'no-cache','pragma':'no-cache'});
  await tryFetch('E UA Chrome 153', {cookie: ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36','accept':'text/html,application/xhtml+xml'});
})();
