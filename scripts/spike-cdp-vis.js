const path=require('path');
const fs=require('fs');
const {Builder, By}=require('selenium-webdriver');
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
  if(!acc) throw new Error('no acc');
  console.log('Pick',acc.uid);

  const {exe, driverBin}=await resolveChrome();
  console.log('Chrome',exe.slice(-50), driverBin? 'bundled':'system');

  const profileDir=path.join(require('os').tmpdir(),'fb-cdp-vis-'+Date.now());
  fs.mkdirSync(profileDir,{recursive:true});

  const opts=new chrome.Options();
  opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation');
  // KHONG headless
  opts.addArguments('--window-size=1280,900','--disable-gpu');

  // Enable CDP logging
  opts.setPerfLoggingPrefs({enableNetwork:true, enablePage:false});
  opts.setLoggingPrefs({performance:'ALL', browser:'ALL'});

  const svc=driverBin?new chrome.ServiceBuilder(driverBin):null;
  let builder=new Builder().forBrowser('chrome').setChromeOptions(opts);
  if(svc) builder=builder.setChromeService(svc);
  if(!driverBin){
    const mng=path.join(path.dirname(require.resolve('selenium-webdriver/package.json')),'bin','windows','selenium-manager.exe');
    if(fs.existsSync(mng)) process.env.SE_MANAGER_PATH=mng;
  } else process.env.SE_CHROMEDRIVER=driverBin;

  const driver=await builder.build();
  const captured=[];
  let cdpConn=null;
  try{
    // Try BiDi CDP connection
    try{
      if(typeof driver.createCDPConnection==='function'){
        cdpConn=await driver.createCDPConnection('page');
        await cdpConn.execute('Network.enable', {});
        cdpConn.on('Network.requestWillBeSent', (params)=>{
          const url=params.request?.url||'';
          if(url.includes('/api/graphql')){
            const postData=params.request?.postData||'';
            const m=postData.match(/doc_id=([^&]+)/);
            const f=postData.match(/fb_api_req_friendly_name=([^&]+)/);
            if(m) captured.push({did: decodeURIComponent(m[1]), friendly: f?decodeURIComponent(f[1]):'', url: url.slice(0,120)});
          }
        });
        console.log('CDP BiDi connected');
      } else {
        console.log('No createCDPConnection');
      }
    }catch(e){ console.log('CDP conn fail', e.message.slice(0,300)); }

    await driver.get('https://www.facebook.com/');
    await driver.sleep(1200);
    for(const c of toCdpCookies(acc)){
      const p={name:c.name,value:String(c.value),domain:c.domain||'.facebook.com',path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly};
      if(c.expires&&c.expires>0) p.expiry=Math.floor(c.expires);
      try{await driver.manage().addCookie(p);}catch{ try{p.domain='facebook.com'; await driver.manage().addCookie(p);}catch{}}
    }
    await driver.get('https://www.facebook.com/');
    await driver.sleep(3000);
    console.log('Logged in', (await driver.getCurrentUrl()).slice(0,100));

    console.log('Go pages...');
    await driver.get('https://www.facebook.com/pages/?category=your_pages');
    await driver.sleep(9000);
    // scroll
    for(let i=0;i<3;i++){ await driver.executeScript('window.scrollTo(0, document.body.scrollHeight)'); await driver.sleep(2000); }

    console.log('CDP captured', captured.length);
    for(const c of captured.slice(0,20)) console.log(c.did, c.friendly);

    // Also try performance logs
    try{
      const logs=await driver.manage().logs().get('performance');
      const gql=logs.map(l=>{try{return JSON.parse(l.message).message}catch{return null}}).filter(m=>m&&m.params&&m.params.request&&m.params.request.url&&m.params.request.url.includes('graphql'));
      console.log('perf logs graphql', gql.length);
      for(const g of gql.slice(0,10)){
        const url=g.params.request.url;
        const post=g.params.request.postData||'';
        const m=post.match(/doc_id=([^&]+)/);
        const f=post.match(/fb_api_req_friendly_name=([^&]+)/);
        console.log('LOG', m?decodeURIComponent(m[1]):'(no doc)', f?decodeURIComponent(f[1]):'', url.slice(0,80));
      }
      if(gql.length && !captured.length){
        // dedup from logs
        const fromLogs=gql.map(g=>{
          const post=g.params.request.postData||'';
          const m=post.match(/doc_id=([^&]+)/);
          const f=post.match(/fb_api_req_friendly_name=([^&]+)/);
          return m?{did:decodeURIComponent(m[1]), friendly:f?decodeURIComponent(f[1]):''}:null;
        }).filter(Boolean);
        console.log('from logs dedup', [...new Map(fromLogs.map(x=>[x.did,x])).values()].slice(0,10).map(x=>x.did+' '+x.friendly).join(' | ').slice(0,800));
      }
    }catch(e){ console.log('perf logs fail', e.message.slice(0,400)); }

    if(!captured.length){
      // Fallback: try calling Graph API directly for pages
      console.log('Trying Graph API me/accounts...');
      const tokenInfo = await driver.executeAsyncScript(`
        const cb=arguments[arguments.length-1];
        (async()=>{
          try{
            const html=document.documentElement.outerHTML;
            const m=html.match(/"accessToken":"([^"]+)"/);
            cb({hasToken: !!m, token: m?m[1].slice(0,40):''});
          }catch(e){ cb({error: String(e)}); }
        })();
      `);
      console.log('accessToken present', tokenInfo);
    }

  } finally {
    try{await driver.quit();}catch{}
    try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}
    console.log('Done');
  }
}
main().catch(e=>{console.error(e); process.exit(1);});
