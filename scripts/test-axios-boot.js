const path=require('path');
const Store=require('../src/store');
const {cookieHeader}=require('../src/exporter');
const DATA=path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');
const store=new Store(DATA); store.load();
const a=store.list().find(x=>x.uid==='100095437232993');
const ck=a.cookie||cookieHeader(a);
const axios=require('axios');
(async()=>{
  const url='https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1';
  try{
    const res=await axios.get(url,{headers:{Cookie: ck, 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'*/*'}});
    console.log('axios status',res.status);
    let txt=typeof res.data==='string'?res.data: JSON.stringify(res.data);
    console.log('len',txt.length);
    console.log(txt.slice(0,3000).replace(/\n/g,' '));
    console.log('has AdsCanvasConfig',txt.includes('AdsCanvasConfig'));
  }catch(e){
    console.log('axios err',e.message);
    if(e.response) {console.log('resp',e.response.status, JSON.stringify(e.response.data).slice(0,2000));}
  }
  // also try fetch with more headers
  try{
    const res2=await fetch(url,{headers:{cookie: ck, 'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','accept':'*/*','accept-language':'en-US,en;q=0.9','sec-fetch-site':'same-origin'}});
    const t2=await res2.text();
    console.log('fetch2 status',res2.status,'len',t2.length);
    console.log(t2.slice(0,2000).replace(/\n/g,' '));
  }catch(e){ console.log('fetch2 err',e.message);}
})();
