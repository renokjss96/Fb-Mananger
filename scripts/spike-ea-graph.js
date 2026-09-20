const path=require('path');
const fs=require('fs');
const {Builder}=require('selenium-webdriver');
const chrome=require('selenium-webdriver/chrome');
const Store=require('../src/store');
const {toCdpCookies}=require('../src/exporter');
const {findBundledChrome, bundledChromedriver, detectChromium}=require('../src/detect');

async function resolveChrome(){
  let p=findBundledChrome(); if(p) return {exe:p, driverBin:bundledChromedriver()};
  const d=detectChromium(); if(d) return {exe:d.path, driverBin:''};
  throw new Error('no chrome');
}
function dataFile(){ return path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json'); }

async function main(){
  const store=new Store(dataFile()); store.load();
  const acc=store.list().find(a=>a.uid==='100095437232993');
  console.log('Pick',acc.uid);
  const {exe, driverBin}=await resolveChrome();
  const profileDir=path.join(require('os').tmpdir(),'fb-ea-'+Date.now());
  fs.mkdirSync(profileDir,{recursive:true});
  const opts=new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  opts.addArguments('--window-size=1280,900');
  let builder=new Builder().forBrowser('chrome').setChromeOptions(opts);
  const svc=driverBin?new chrome.ServiceBuilder(driverBin):null;
  if(svc) builder=builder.setChromeService(svc);
  if(!driverBin){
    const mng=path.join(path.dirname(require.resolve('selenium-webdriver/package.json')),'bin','windows','selenium-manager.exe');
    if(fs.existsSync(mng)) process.env.SE_MANAGER_PATH=mng;
  } else process.env.SE_CHROMEDRIVER=driverBin;
  const driver=await builder.build();
  try{
    await driver.get('https://www.facebook.com/'); await driver.sleep(1200);
    for(const c of toCdpCookies(acc)){
      const p={name:c.name,value:String(c.value),domain:c.domain||'.facebook.com',path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly};
      if(c.expires&&c.expires>0) p.expiry=Math.floor(c.expires);
      try{await driver.manage().addCookie(p);}catch{ try{p.domain='facebook.com'; await driver.manage().addCookie(p);}catch{}}
    }
    await driver.get('https://www.facebook.com/'); await driver.sleep(3000);
    console.log('logged in', (await driver.getCurrentUrl()).slice(0,80));

    const eaData = await driver.executeScript(`
      const html=document.documentElement.outerHTML;
      const re=/EA[A-Za-z0-9]{20,}/g;
      const found=[...new Set([...html.matchAll(re)].map(m=>m[0]))];
      // filter plausible tokens (length 40-250 and not long base64 junk)
      const plausible=found.filter(t=>t.length>=40 && t.length<=300);
      return {all: found.slice(0,15).map(t=>t.slice(0,80)+' len='+t.length), plausible: plausible.slice(0,8).map(t=>t.slice(0,80)+' len='+t.length), rawPlausible: plausible.slice(0,8)};
    `);
    console.log('EA all', eaData.all.slice(0,6));
    console.log('EA plausible', eaData.plausible);

    // Try Graph API inside browser using those tokens
    const graphRes = await driver.executeAsyncScript(`
      const raw = arguments[0];
      const cb=arguments[arguments.length-1];
      (async()=>{
        const results=[];
        for(const tok of raw.slice(0,4)){
          try{
            const url='https://graph.facebook.com/v20.0/me/accounts?fields=id,name,category,fan_count,followers_count,access_token,tasks&limit=50&access_token='+encodeURIComponent(tok);
            const res=await fetch(url);
            const text=await res.text();
            let json; try{ json=JSON.parse(text)}catch{ json={raw:text.slice(0,800)}}
            results.push({tok: tok.slice(0,20), status: res.status, ok: !!json.data, dataLen: json.data?json.data.length:0, error: json.error? JSON.stringify(json.error).slice(0,500):'', sample: json.data? json.data.slice(0,2): null});
            if(json.data && json.data.length) break;
          }catch(e){ results.push({tok: raw[0].slice(0,20), error: String(e).slice(0,300)}); }
        }
        cb(results);
      })();
    `, eaData.rawPlausible||[]);
    console.log('Graph API results:', JSON.stringify(graphRes, null, 2).slice(0,6000));
    for(const r of graphRes||[]){
      if(r.sample) console.log('Sample page keys', Object.keys(r.sample[0]||{}), JSON.stringify(r.sample[0], null, 2).slice(0,2500));
    }

    // Also try via cookie-based Graph: /me/accounts without token but with dtsg session (some endpoints allow)
    const cookieGraph = await driver.executeAsyncScript(`
      const cb=arguments[arguments.length-1];
      (async()=>{
        try{
          const html=document.documentElement.outerHTML;
          function m(re){ const x=html.match(re); return x?x[1]:''; }
          const dtsg=m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || '';
          const url='https://graph.facebook.com/v20.0/me/accounts?fields=id,name,category,fan_count,followers_count,tasks&limit=5';
          const res=await fetch(url, {credentials:'include', headers: {'X-FB-Friendly-Name':'test'}});
          const text=await res.text();
          cb({status: res.status, text: text.slice(0,2000)});
        }catch(e){ cb({error: String(e)}); }
      })();
    `);
    console.log('Cookie graph try', JSON.stringify(cookieGraph).slice(0,2000));

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
