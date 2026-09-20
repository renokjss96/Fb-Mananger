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

async function runOnce(acc, exe, driverBin, attempt){
  const profileDir=path.join(require('os').tmpdir(),'fb-spike2-'+Date.now());
  fs.mkdirSync(profileDir,{recursive:true});
  const opts=new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  opts.addArguments('--window-size=1280,900');
  opts.setPerfLoggingPrefs({enableNetwork:true, enablePage:false});
  opts.setLoggingPrefs({performance:'ALL'});
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
    console.log(`[${attempt}] logged in`, (await driver.getCurrentUrl()).slice(0,80));

    // Search for EA token in page
    const tokSearch = await driver.executeScript(`
      const html=document.documentElement.outerHTML;
      const re=/EA[A-Za-z0-9]{20,}/g;
      const found=[...html.matchAll(re)].map(m=>m[0]).slice(0,5);
      // also look for accessToken
      const re2=/"accessToken":"([^"]+)"/g;
      const found2=[...html.matchAll(re2)].map(m=>m[1].slice(0,40)).slice(0,3);
      return {found, found2, htmlLen: html.length};
    `);
    console.log('EA tokens', tokSearch);

    // Try Graph API via browser fetch using cookie (not token) - /me/accounts via graphql with different doc
    // Do direct fetch to graph.facebook.com with cookie-based auth? Try: fetch('/api/graphql' with variables for pages)
    // Try calling via fetch inside browser to me/accounts via REST
    const graphTry = await driver.executeAsyncScript(`
      const cb=arguments[arguments.length-1];
      (async()=>{
        try{
          // Try Business Graph: fetch pages via /ajax/pages
          const tests=[];
          // 1) Try graph.facebook.com/me/accounts with no token but with cookie (might work with fb_dtsg)
          const html=document.documentElement.outerHTML;
          function m(re){ const x=html.match(re); return x?x[1]:''; }
          const dtsg=m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || '';
          const ck=document.cookie;
          const uid=(ck.match(/c_user=(\\d+)/)||[])[1]||'0';
          tests.push('dtsg:'+!!dtsg+' uid:'+uid);
          // 2) Try fetching via https://www.facebook.com/ajax/pagelet/generic.php?dpr=1 using pages context
          // 3) Try REST Graph with EA token if found
          // Just probe: try to call /api/graphql with a known working doc like Viewer query and see response
          // Instead, try to scrape DOM for page data-attributes
          const links=Array.from(document.querySelectorAll('a[href*="facebook.com/"]')).map(a=>a.href).filter(h=>/profile\\.php\\?id=\\d+/.test(h)).slice(0,15);
          const pagelets=Array.from(document.querySelectorAll('[data-pagelet]')).map(e=>e.getAttribute('data-pagelet')).slice(0,10);
          cb({tests, links: links.slice(0,10), pagelets});
        }catch(e){ cb({error:String(e)}); }
      })();
    `);
    console.log('graphTry', JSON.stringify(graphTry, null, 2).slice(0,3000));

    // Navigate to pages and dump more logs
    await driver.get('https://www.facebook.com/pages/?category=your_pages');
    await driver.sleep(8000);
    for(let i=0;i<2;i++){ await driver.executeScript('window.scrollTo(0, document.body.scrollHeight)'); await driver.sleep(2000); }

    const logs=await driver.manage().logs().get('performance');
    const msgs=logs.map(l=>{try{return JSON.parse(l.message).message}catch{return null}}).filter(Boolean);
    const gql=msgs.filter(m=>m.params&&m.params.request&&m.params.request.url&&m.params.request.url.includes('graphql'));
    console.log('graphql count', gql.length);
    const decoded=gql.map(g=>{
      const post=g.params.request.postData||'';
      const did=(post.match(/doc_id=([^&]+)/)||[])[1]||'';
      const fr=(post.match(/fb_api_req_friendly_name=([^&]+)/)||[])[1]||'';
      return did? decodeURIComponent(did)+' '+decodeURIComponent(fr):'';
    }).filter(Boolean);
    console.log('decoded doc_ids present?', decoded.length);
    for(const d of [...new Set(decoded)].slice(0,30)) console.log(' ',d);
    if(!decoded.length){
      console.log('No doc_id in postData — FB now uses volatil/encrypted batch. Trying response inspection via perf?');
      // Try to get response bodies? not available via perf logs
    }

    // Try alternative: use Chrome DevTools fetch to directly call Graph API with uid
    const directFetch = await driver.executeAsyncScript(`
      const cb=arguments[arguments.length-1];
      (async()=>{
        try{
          const html=document.documentElement.outerHTML;
          function m(re){ const x=html.match(re); return x?x[1]:''; }
          const dtsg=m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || '';
          const lsd=m(/"LSD"[^}]*"token":"([^"]+)"/) || '';
          const jazoest=(html.match(/jazoest=(\\d+)/)||[])[1]||'25537';
          const ck=document.cookie;
          const uid=(ck.match(/c_user=(\\d+)/)||[])[1]||'0';
          // Try a simple query that is known to work: Viewer
          // We'll try to call with persisted document for pages using empty doc_id fallback via require
          cb({dtsg: !!dtsg, lsd: !!lsd, jazoest, uid});
        }catch(e){ cb({error:String(e)}); }
      })();
    `);
    console.log('directFetch probe', directFetch);

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
  }
}

async function main(){
  const store=new Store(dataFile()); store.load();
  const acc=store.list().find(a=>a.uid==='100095437232993');
  const {exe, driverBin}=await resolveChrome();
  console.log('Chrome',exe.slice(-50));
  await runOnce(acc, exe, driverBin, 'A');
}
main().catch(e=>{console.error(e); process.exit(1);});
