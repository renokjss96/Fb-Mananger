const path=require('path');
const Store=require('../src/store');
const {fetchTokens}=require('../src/pages');
const {cookieHeader}=require('../src/exporter');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const s=new Store(DATA); s.load();
const acc=s.list().find(a=>a.uid==='100058089476414') || s.list()[0];
const ck=acc.cookie||cookieHeader(acc);
console.log('uid',acc.uid,'status',acc.status,'ck len',ck.length,'has c_user',/c_user=/.test(ck));
console.log('cookie preview',ck.slice(0,180));
(async()=>{
  try{
    const t=await fetchTokens(ck);
    console.log('TOKENS ok',JSON.stringify(t).slice(0,600));
  }catch(e){
    console.log('TOKENS fail:',e.message);
    const res=await fetch('https://www.facebook.com/',{headers:{cookie:ck,'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36','accept':'text/html,application/xhtml+xml'}});
    console.log('GET / status',res.status, res.headers.get('location')||'');
    const h=await res.text();
    console.log('html len',h.length);
    console.log(h.slice(0,3000).replace(/\n/g,' ').slice(0,3000));
    console.log('has DTSG',h.includes('DTSG'),'has DTSGInitialData',h.includes('DTSGInitialData'),'checkpoint',h.toLowerCase().includes('checkpoint'),'login',h.includes('id="email"')||h.includes('name="email"'));
    // check ownerTokens
    console.log('ownerTokens in store', JSON.stringify(s.getOwnerTokens(acc.id)||null).slice(0,500));
  }
})();
