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
  const profileDir=path.join(require('os').tmpdir(),'fb-bundle-'+Date.now());
  fs.mkdirSync(profileDir,{recursive:true});
  const opts=new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  opts.addArguments('--window-size=1280,900');
  opts.setPerfLoggingPrefs({enableNetwork:true}); opts.setLoggingPrefs({performance:'ALL'});
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
    await driver.get('https://www.facebook.com/pages/?category=your_pages');
    await driver.sleep(7000);

    // Collect script URLs from performance
    const scripts = await driver.executeScript(`
      return performance.getEntriesByType('resource')
        .filter(e=>e.name.includes('.js'))
        .map(e=>e.name)
        .slice(0,120);
    `);
    console.log('Scripts', scripts.length);
    // Find bundle likely containing pages
    const candidates = scripts.filter(u=> /rsrc\.php|static/.test(u));
    console.log('candidate bundles', candidates.slice(0,20).join('\\n').slice(0,2000));

    // Search HTML for any doc id near Pages string
    const search = await driver.executeScript(`
      const html=document.documentElement.outerHTML;
      const idx=html.indexOf('AllPagesListForUser');
      if(idx<0) return {found:false, htmlLen: html.length};
      return {found:true, slice: html.slice(Math.max(0,idx-2000), idx+3000)};
    `);
    console.log('AllPagesListForUser in HTML?', search.found);
    if(search.found) console.log(search.slice.slice(0,3000).replace(/\\n/g,' '));

    // Try Node's fetch on a few bundles
    const fetch = global.fetch;
    let foundDoc=null;
    for(const u of candidates.slice(0,15)){
      try{
        const res=await fetch(u, {headers:{'user-agent':'Mozilla/5.0'}});
        const text=await res.text();
        if(text.includes('AllPagesListForUser') || text.includes('CometAllPages')){
          console.log('FOUND in', u);
          const re=/doc_id["'\\s:]+(\\d{15,16})/g;
          const ids=[...text.matchAll(re)].map(m=>m[1]).slice(0,10);
          console.log(' ids', ids);
          // also search for pages query name
          const re2=/(\\d{15,16})[^\\n]{0,300}AllPages/i;
          const m2=text.match(/AllPages.{0,500}(\\d{15,16})/i);
          if(m2) console.log(' m2', m2[1]);
          foundDoc = ids[0];
          break;
        }
      }catch(e){ console.log('fetch fail', u.slice(0,80), e.message.slice(0,80)); }
    }
    if(!foundDoc) console.log('No bundle with AllPages string');

    // Fallback: try calling business.facebook.com pages endpoint via browser fetch
    const biz = await driver.executeAsyncScript(`
      const cb=arguments[arguments.length-1];
      (async()=>{
        try{
          const res=await fetch('https://business.facebook.com/pages/?category=your_pages', {credentials:'include'});
          const t=await res.text();
          const idx=t.indexOf('AllPages');
          cb({len: t.length, has: idx>=0, slice: idx>=0? t.slice(Math.max(0,idx-2000), idx+2000): t.slice(0,1500)});
        }catch(e){ cb({error: String(e)}); }
      })();
    `);
    console.log('biz fetch', JSON.stringify(biz).slice(0,2500));

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
