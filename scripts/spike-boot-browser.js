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
  const profileDir=path.join(require('os').tmpdir(),'fb-boot-'+Date.now());
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
    console.log('logged', (await driver.getCurrentUrl()).slice(0,80));

    const boot = await driver.executeAsyncScript(`
      const cb=arguments[arguments.length-1];
      fetch("https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1", {credentials:"include"})
        .then(r=>r.text()).then(t=>cb({ok:true, len:t.length, slice:t.slice(0,4000)}))
        .catch(e=>cb({ok:false, err:String(e)}));
    `);
    console.log('boot ok',boot.ok,'len',boot.len);
    console.log(boot.slice? boot.slice.slice(0,2500).replace(/\n/g,' '): boot.err);
    if(boot.ok){
      let raw=boot.slice.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/,'');
      // need to get full text not just 4000
      const full = await driver.executeAsyncScript(`
        const cb=arguments[arguments.length-1];
        fetch("https://www.facebook.com/ajax/bootloader-endpoint/?modules=AdsCanvasComposerDialog.react&__a=1", {credentials:"include"})
          .then(r=>r.text()).then(t=>cb(t))
          .catch(e=>cb("ERR:"+e));
      `);
      console.log('full len',full.length);
      console.log('has AdsCanvasConfig', full.includes('AdsCanvasConfig'));
      if(full.includes('AdsCanvasConfig')){
        const idx=full.indexOf('AdsCanvasConfig');
        console.log(full.slice(Math.max(0,idx-500), idx+3000).replace(/\n/g,' ').slice(0,3000));
        // try parse
        let cleaned=full.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/,'');
        try{
          const j=JSON.parse(cleaned);
          function find(obj){
            if(Array.isArray(obj)){ for(const it of obj){ if(Array.isArray(it)&&it[0]==='AdsCanvasConfig') return it; const f=find(it); if(f) return f; } }
            else if(obj&&typeof obj==='object'){ for(const k in obj){ const f=find(obj[k]); if(f) return f; } }
            return null;
          }
          const cfg=find(j);
          console.log('cfg found', !!cfg, cfg? JSON.stringify(cfg).slice(0,800):'');
          if(cfg && cfg[2] && cfg[2].access_token){
            const tok=cfg[2].access_token;
            console.log('TOKEN', tok.slice(0,30), 'len',tok.length);
            // try graph
            const gres = await driver.executeAsyncScript(`
              const tok=arguments[0];
              const cb=arguments[arguments.length-1];
              fetch("https://graph.facebook.com/v20.0/me/accounts?fields=id,name,category,fan_count,followers_count,picture,is_published,access_token&limit=100&access_token="+encodeURIComponent(tok), {credentials:"include"})
                .then(r=>r.text()).then(t=>cb({ok:true, text:t.slice(0,8000)})).catch(e=>cb({ok:false, err:String(e)}));
            `, tok);
            console.log('graph via browser len', gres.text? gres.text.length:0);
            console.log((gres.text||gres.err||'').slice(0,6000));
            if(gres.text){
              try{ const gj=JSON.parse(gres.text); console.log('pages', gj.data? gj.data.length:0); if(gj.data) console.log(JSON.stringify(gj.data.slice(0,2),null,2).slice(0,3000)); if(gj.error) console.log('err',JSON.stringify(gj.error).slice(0,800)); }catch(e){ console.log('parse fail',e.message.slice(0,200));}
            }
          }
        }catch(e){ console.log('parse err',String(e).slice(0,300));}
      }
    }
  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
