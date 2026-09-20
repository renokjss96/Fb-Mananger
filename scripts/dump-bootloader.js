const path=require('path');
const Store=require('../src/store');
const {cookieHeader}=require('../src/exporter');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const store=new Store(DATA); store.load();
const a=store.list().find(x=>x.uid==='100095437232993');
const ck=a.cookie||cookieHeader(a);
(async()=>{
  const url='https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1';
  const res=await fetch(url,{headers:{cookie:ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36','accept':'*/*'}});
  const text=await res.text();
  console.log('status',res.status);
  console.log('len',text.length);
  console.log(text.slice(0,3000).replace(/\n/g,' '));
  console.log('has AdsCanvasConfig', text.includes('AdsCanvasConfig'));
  console.log('has access_token', text.includes('access_token'));
  // also try alternative endpoint used by extension: same but via facebook.com with no modules?
  const raw=text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/,'');
  try{const j=JSON.parse(raw); console.log('parsed type', Array.isArray(j)?'array len '+j.length: typeof j); }catch(e){ console.log('parse err',e.message.slice(0,200));}
})();
