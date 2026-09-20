#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const VENDOR = path.join(__dirname, '..', 'vendor');
const CHROME_DIR = path.join(VENDOR, 'chrome-win64');
const DRIVER_DIR = path.join(VENDOR, 'chromedriver');

function log(m) { console.log('[fetch-chrome] ' + m); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function unzip(zipPath, outDir) {
  // Use PowerShell Expand-Archive if available (Windows)
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    execFile('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${outDir}"`
    ], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

async function main() {
  const skip = process.env.SKIP_CHROME_FETCH === '1';
  const hasChrome = fs.existsSync(path.join(CHROME_DIR, 'chrome.exe'));
  const hasDriver = fs.existsSync(path.join(DRIVER_DIR, 'chromedriver.exe'));
  if (hasChrome && hasDriver) {
    log('vendor already present — skip download (delete vendor/ to re-fetch)');
    return;
  }
  if (skip) { log('SKIP_CHROME_FETCH=1 — skip'); return; }

  log('fetching last known good versions...');
  const versions = await fetchJson('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
  const stable = versions.channels && versions.channels.Stable;
  if (!stable) throw new Error('no Stable channel in CfT json');
  const ver = stable.version;
  log('Stable ' + ver);

  const chromeEntry = stable.downloads.chrome.find((x) => x.platform === 'win64');
  const driverEntry = stable.downloads.chromedriver.find((x) => x.platform === 'win64');
  if (!chromeEntry || !driverEntry) throw new Error('win64 chrome/chromedriver not in CfT');

  fs.mkdirSync(VENDOR, { recursive: true });
  const chromeZip = path.join(VENDOR, 'chrome-win64.zip');
  const driverZip = path.join(VENDOR, 'chromedriver-win64.zip');

  if (!hasChrome) {
    log('downloading chrome ' + chromeEntry.url);
    await download(chromeEntry.url, chromeZip);
    log('extracting chrome...');
    const tmp = path.join(VENDOR, '_chrome_tmp');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    await unzip(chromeZip, tmp);
    // chrome zip contains chrome-win64/chrome.exe
    const inner = path.join(tmp, 'chrome-win64');
    try { fs.rmSync(CHROME_DIR, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(path.dirname(CHROME_DIR), { recursive: true });
    fs.renameSync(inner, CHROME_DIR);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(chromeZip); } catch (_) {}
    fs.writeFileSync(path.join(CHROME_DIR, '.version'), ver, 'utf8');
    log('chrome ready: ' + CHROME_DIR);
  }

  if (!hasDriver) {
    log('downloading chromedriver ' + driverEntry.url);
    await download(driverEntry.url, driverZip);
    log('extracting chromedriver...');
    const tmp2 = path.join(VENDOR, '_driver_tmp');
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (_) {}
    await unzip(driverZip, tmp2);
    const inner2 = path.join(tmp2, 'chromedriver-win64');
    try { fs.rmSync(DRIVER_DIR, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(DRIVER_DIR, { recursive: true });
    // inner2 contains chromedriver.exe + LICENSE etc
    for (const f of fs.readdirSync(inner2)) {
      fs.copyFileSync(path.join(inner2, f), path.join(DRIVER_DIR, f));
    }
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(driverZip); } catch (_) {}
    fs.writeFileSync(path.join(DRIVER_DIR, '.version'), ver, 'utf8');
    log('chromedriver ready: ' + DRIVER_DIR);
  }
  log('done — version ' + ver);
}

main().catch((e) => { console.error(e); process.exit(1); });
