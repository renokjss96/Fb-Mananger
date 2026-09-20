const path = require('path');
const fs = require('fs');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const Store = require('../src/store');
const { toCdpCookies } = require('../src/exporter');
const { findBundledChrome, bundledChromedriver, detectChromium } = require('../src/detect');

async function resolveChrome(){
  let p=findBundledChrome(); if(p) return {exe:p, driverBin:bundledChromedriver()};
  const d=detectChromium(); if(d) return {exe:d.path, driverBin:''};
  throw new Error('No Chrome');
}
function dataFile(){ return path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json'); }

async function main(){
  const store=new Store(dataFile()); store.load();
  const acc=store.list().find(a=>a.uid==='100095437232993');
  if(!acc) throw new Error('no acc');
  console.log('Pick',acc.uid);

  const {exe, driverBin}=await resolveChrome();
  const profileDir=path.join(require('os').tmpdir(),'fb-cdp-'+Date.now());
  fs.mkdirSync(profileDir,{recursive:true});

  const opts=new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  opts.addArguments('--headless=new','--disable-gpu','--window-size=1280,900');

  const svc=driverBin?new chrome.ServiceBuilder(driverBin):null;
  let builder=new Builder().forBrowser('chrome').setChromeOptions(opts);
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
    await driver.get('https://www.facebook.com/'); await driver.sleep(2500);

    // Enable CDP Network
    const cdp = driver;
    // selenium 4: use sendAndGetDevToolsCommand or executeCdpCommand
    async function cdpCmd(method, params){
      if(typeof cdp.executeCdpCommand==='function') return cdp.executeCdpCommand(method, params);
      if(typeof cdp.sendDevToolsCommand==='function') return cdp.sendDevToolsCommand(method, params);
      throw new Error('no cdp method');
    }
    try{
      await cdpCmd('Network.enable', {});
      console.log('CDP Network enabled');
    }catch(e){ console.log('CDP enable fail', e.message); }

    const captured=[];
    // Try to listen via CDP event - selenium doesn't expose events easily, so poll via JS hook + also use Network.getAllCookies etc.
    // Instead, also install hook again and navigate
    await driver.executeScript(`
      window.__fbDocIds2=[];
      const origFetch=window.fetch;
      window.fetch=function(input,init){
        try{
          const url=typeof input==='string'?input: input.url||'';
          const body=(init&&init.body)|| (typeof input!=='string'&&input.body)||'';
          const bstr=typeof body==='string'?body:'';
          if(url.includes('/api/graphql')){
            const did=(bstr.match(/doc_id=([^&]+)/)||[])[1]||(url.match(/doc_id=([^&]+)/)||[])[1]||'';
            const friendly=(bstr.match(/fb_api_req_friendly_name=([^&]+)/)||[])[1]||'';
            if(did) window.__fbDocIds2.push({did: decodeURIComponent(did), friendly: decodeURIComponent(friendly||''), url:url.slice(0,200)});
          }
        }catch(e){}
        return origFetch.apply(this, arguments);
      };
      const op=XHR=>{const o=XHR.prototype.open, s=XHR.prototype.send; XHR.prototype.open=function(m,u){this._fbUrl=u; return o.apply(this, arguments)}; XHR.prototype.send=function(b){try{const u=this._fbUrl||''; const bs=typeof b==='string'?b:''; if(u.includes('/api/graphql')){const did=(bs.match(/doc_id=([^&]+)/)||[])[1]||(u.match(/doc_id=([^&]+)/)||[])[1]||''; const fr=(bs.match(/fb_api_req_friendly_name=([^&]+)/)||[])[1]||''; if(did) window.__fbDocIds2.push({did:decodeURIComponent(did), friendly:decodeURIComponent(fr||''), url:u.slice(0,200)});}}catch(e){} return s.apply(this, arguments)}}; op(XMLHttpRequest);
    `);

    console.log('Navigating to pages...');
    await driver.get('https://www.facebook.com/pages/?category=your_pages');
    await driver.sleep(10000);
    // scroll to trigger lazy load
    await driver.executeScript('window.scrollTo(0, 800)');
    await driver.sleep(3000);
    await driver.executeScript('window.scrollTo(0, 1600)');
    await driver.sleep(3000);

    let docs = await driver.executeScript('return window.__fbDocIds2||[]');
    console.log('Hook docs', docs.length);
    for(const d of docs) console.log(d.did, d.friendly);

    // Also dump localStorage keys that might contain doc ids
    const lsKeys = await driver.executeScript('return Object.keys(localStorage).slice(0,30)');
    console.log('localStorage keys', lsKeys.slice(0,10));

    // Try to brute force: call the old doc via fetch inside browser and see error, then try to discover via __spin_r / __spin_t etc.
    // Alternative: search HTML for doc_id patterns
    const htmlIds = await driver.executeScript(`
      const html=document.documentElement.outerHTML;
      const re=/doc_id["':=\\s]+(\\d{15,16})/g;
      const out=[]; let m; while(m=re.exec(html)) out.push(m[1]);
      return [...new Set(out)].slice(0,20);
    `);
    console.log('HTML doc_ids', htmlIds);

    // Try performance entries with initiator
    const perf = await driver.executeScript(`return performance.getEntriesByType('resource').filter(e=>e.name.includes('graphql')).map(e=>e.name).slice(0,5).join('\\n')`);
    console.log('perf graphql', perf.slice(0,500));

    // If still none, try to dump what pages are visible via DOM
    const pageLinks = await driver.executeScript(`
      return Array.from(document.querySelectorAll('a[href*="facebook.com/"]')).map(a=>a.href).filter(h=>/facebook\\.com\\//.test(h)).slice(0,20);
    `);
    console.log('page links sample', pageLinks.slice(0,10));

    if(!docs.length){
      // Try non-headless style: maybe FB detects headless. Log that.
      console.log('No docs via hook — likely FB blocks headless GraphQL batching. Try verifying via DOM scrape.');
      const domPages = await driver.executeScript(`
        const els = Array.from(document.querySelectorAll('[data-pagelet]'));
        return els.map(e=>e.textContent.slice(0,200)).slice(0,5).join('\\n---\\n');
      `);
      console.log('DOM pagelets', domPages.slice(0,2000));
    }

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
