const path = require('path');
const fs = require('fs');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const Store = require('../src/store');
const { toCdpCookies } = require('../src/exporter');
const { findBundledChrome, bundledChromedriver, detectChromium } = require('../src/detect');

async function resolveChrome() {
  let p = findBundledChrome();
  if (p) return { exe: p, driverBin: bundledChromedriver() };
  const d = detectChromium();
  if (d) return { exe: d.path, driverBin: '' };
  throw new Error('No Chrome');
}
function dataFile(){ return path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json'); }

async function main(){
  const store=new Store(dataFile()); store.load();
  const acc = store.list().find(a=>a.uid==='100095437232993') || store.list().find(a=>(a.cookie||'').length>300);
  if(!acc) throw new Error('No acc');
  console.log('Pick',acc.uid, acc.cookie.length);

  const {exe, driverBin}=await resolveChrome();
  console.log('Chrome',exe.slice(-50));

  const profileDir=path.join(require('os').tmpdir(),'fb-spike-docid-'+Date.now());
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
    await driver.get('https://www.facebook.com/');
    await driver.sleep(1200);
    const cookies=toCdpCookies(acc);
    for(const c of cookies){
      const payload={name:c.name,value:String(c.value),domain:c.domain||'.facebook.com',path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly};
      if(c.expires&&c.expires>0) payload.expiry=Math.floor(c.expires);
      try{await driver.manage().addCookie(payload);}catch{ try{payload.domain='facebook.com'; await driver.manage().addCookie(payload);}catch{}}
    }
    await driver.get('https://www.facebook.com/');
    await driver.sleep(2500);
    console.log('Logged in, url', (await driver.getCurrentUrl()).slice(0,120));

    // Install fetch/XHR hook
    await driver.executeScript(`
      window.__fbDocIds = [];
      window.__fbReqs = [];
      const origFetch = window.fetch;
      window.fetch = function(input, init){
        try{
          const url = typeof input==='string'?input: input.url||'';
          const body = (init&&init.body)|| (typeof input!=='string'&&input.body) || '';
          const bstr = typeof body==='string'?body:'';
          if(url.includes('/api/graphql')){
            const did = (bstr.match(/doc_id=([^&]+)/)||[])[1] || (url.match(/doc_id=([^&]+)/)||[])[1] || '';
            const friendly = (bstr.match(/fb_api_req_friendly_name=([^&]+)/)||[])[1]||'';
            if(did) { window.__fbDocIds.push({did: decodeURIComponent(did), friendly: decodeURIComponent(friendly||'')}); window.__fbReqs.push(url.slice(0,300)+' body:'+bstr.slice(0,800)); }
          }
        }catch(e){}
        return origFetch.apply(this, arguments);
      };
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m,u){ this._fbUrl=u; return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function(body){
        try{
          const u=this._fbUrl||'';
          const bstr= typeof body==='string'?body:'';
          if(u.includes('/api/graphql')){
            const did=(bstr.match(/doc_id=([^&]+)/)||[])[1]||(u.match(/doc_id=([^&]+)/)||[])[1]||'';
            const friendly=(bstr.match(/fb_api_req_friendly_name=([^&]+)/)||[])[1]||'';
            if(did) { window.__fbDocIds.push({did: decodeURIComponent(did), friendly: decodeURIComponent(friendly||'')}); }
          }
        }catch(e){}
        return origSend.apply(this, arguments);
      };
    `);
    console.log('Hook installed, navigating to pages...');

    // Try multiple URLs
    const urls=[
      'https://www.facebook.com/pages/?category=your_pages&ref=aymt_homepage_panel',
      'https://www.facebook.com/pages/?category=your_pages',
      'https://www.facebook.com/pages/',
    ];
    for(const u of urls){
      console.log('GET',u);
      await driver.get(u);
      await driver.sleep(7000);
      const captured = await driver.executeScript('return window.__fbDocIds||[]');
      console.log('  captured so far', captured.length, captured.slice(0,6).map(x=>x.did+' '+x.friendly).join(' | ').slice(0,600));
      if(captured.length>=3) break;
    }

    const final = await driver.executeScript('return window.__fbDocIds||[]');
    console.log('\n=== FINAL docIds ===');
    for(const r of final) console.log(r.did, r.friendly);
    // dedup
    const uniq=[...new Map(final.map(x=>[x.did,x])).values()];
    console.log('\nUNIQ',uniq.length);
    for(const r of uniq) console.log(r.did, r.friendly);

    // Also dump performance entries
    const perf = await driver.executeScript(`return performance.getEntriesByType('resource').filter(e=>e.name.includes('graphql')).map(e=>e.name).slice(0,20)`);
    console.log('\nPerformance graphql entries',perf.length);
    for(const p of perf) console.log(p.slice(0,500));

    // If still none, try HTML scrape for page links
    if(uniq.length===0){
      const htmlLen=await driver.executeScript('return document.documentElement.outerHTML.length');
      console.log('HTML len',htmlLen);
      const snippet=await driver.executeScript('return document.documentElement.outerHTML.slice(0,4000)');
      console.log(snippet.replace(/\n/g,' ').slice(0,3500));
    }

    // Try direct fetch via hook: if we have at least one did, test CometAllPagesList
    const target = uniq.find(x=>/AllPages|PagesList/i.test(x.friendly));
    if(target) console.log('\nTARGET doc for pages:',target.did, target.friendly);
    else if(uniq.length) console.log('\nNo AllPages doc found, first is',uniq[0].did, uniq[0].friendly);

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
    console.log('Done.');
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
