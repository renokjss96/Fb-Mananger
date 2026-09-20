const path=require('path');
const Store=require('../src/store');
const {getFreshAccessTokenFromCookies, getUserPagesViaGraph}=require('../src/pages');
const {cookieHeader}=require('../src/exporter');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const store=new Store(DATA); store.load();
(async()=>{
  const accs=store.list().filter(a=> (a.cookie||'').length>100);
  accs.sort((a,b)=> (a.status==='idle'?-1:1));
  const a=accs[0];
  if(!a){console.log('no acc');return;}
  const ck=a.cookie||cookieHeader(a);
  console.log('Test',a.uid,a.status,ck.length);
  try{
    const tok=await getFreshAccessTokenFromCookies(ck);
    console.log('token ok',tok.slice(0,20), 'len',tok.length);
    const pages=await getUserPagesViaGraph(ck, tok);
    console.log('pages',pages.length);
    for(const p of pages.slice(0,3)) console.log(JSON.stringify(p,null,2));
  }catch(e){ console.error('ERR',e.message); console.error(e.stack&&e.stack.slice(0,1500));}
})();
