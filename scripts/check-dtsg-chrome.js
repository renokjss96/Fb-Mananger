const path=require('path');
const fs=require('fs');
const {Builder}=require('selenium-webdriver');
const chrome=require('selenium-webdriver/chrome');
const Store=require('../src/store');
const {toCdpCookies}=require('../src/exporter');
const {findBundledChrome, bundledChromedriver, detectChromium}=require('../src/detect');
async function resolveChrome(){let p=findBundledChrome(); if(p)return{exe:p,driverBin:bundledChromedriver()}; const d=detectChromium(); if(d)return{exe:d.path,driverBin:''}; throw new Error('no chrome');}
function dataFile(){return path.join(require('os').homedir(),'AppData','Roaming','fb-manager','fb-manager-data.json');}
(async()=>{
  const store=new Store(dataFile()); store.load();
  const acc=store.list().find(a=>a.uid==='100058089476414');
  console.log('uid',acc.uid,'ck len',acc.cookie.length);
  const {exe,driverBin}=await resolveChrome();
  const profileDir=path.join(require('os').tmpdir(),'fb-dtsg-'+Date.now()); fs.mkdirSync(profileDir,{recursive:true});
  const opts=new chrome.Options(); opts.setChromeBinaryPath(exe);
  opts.addArguments(`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled','--lang=vi-VN,vi,en-US,en');
  opts.excludeSwitches('enable-automation'); opts.addArguments('--window-size=1280,900');
  let builder=new Builder().forBrowser('chrome').setChromeOptions(opts);
  const svc=driverBin?new chrome.ServiceBuilder(driverBin):null; if(svc) builder=builder.setChromeService(svc);
  if(!driverBin){const mng=path.join(path.dirname(require.resolve('selenium-webdriver/package.json')),'bin','windows','selenium-manager.exe'); if(fs.existsSync(mng)) process.env.SE_MANAGER_PATH=mng;} else process.env.SE_CHROMEDRIVER=driverBin;
  const driver=await builder.build();
  try{
    await driver.get('https://www.facebook.com/'); await driver.sleep(1200);
    for(const c of toCdpCookies(acc)){const p={name:c.name,value:String(c.value),domain:c.domain||'.facebook.com',path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly}; if(c.expires&&c.expires>0)p.expiry=Math.floor(c.expires); try{await driver.manage().addCookie(p);}catch{try{p.domain='facebook.com';await driver.manage().addCookie(p);}catch{}}}
    await driver.get('https://www.facebook.com/'); await driver.sleep(3500);
    console.log('url',await driver.getCurrentUrl());
    const t=await driver.executeScript(`
      const html=document.documentElement.outerHTML;
      function m(re){const x=html.match(re); return x?x[1]:'';}
      return {dtsg: m(/"DTSGInitialData"[^}]*"token":"([^"]+)"/) || m(/fb_dtsg":"([^"]+)"/) || '', lsd: m(/"LSD"[^}]*"token":"([^"]+)"/) || '', jazoest: (html.match(/jazoest=(\\d+)/)||[])[1]||'', hsi: m(/"hsi":"([^"]+)"/)||'', hasDTSG: html.includes('DTSG')};
    `);
    console.log('tokens via Chrome',JSON.stringify(t,null,2).slice(0,800));
    console.log('hasDTSG',!!t.dtsg,'hasLSD',!!t.lsd);
  }finally{try{await driver.quit();}catch{} try{fs.rmSync(profileDir,{recursive:true,force:true});}catch{}}
})();
