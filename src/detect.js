const fs = require('fs');
const { execFile } = require('child_process');

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function bundledPaths() {
  const list = [];
  try {
    const exeDir = path.dirname(process.execPath);
    list.push(path.join(exeDir, 'chrome', 'chrome.exe'));
    list.push(path.join(exeDir, 'resources', 'chrome', 'chrome.exe'));
  } catch (_) {}
  try {
    list.push(path.join(__dirname, '..', 'data', 'chrome', 'chrome.exe'));
    list.push(path.join(__dirname, '..', 'chrome', 'chrome.exe'));
    list.push(path.join(__dirname, '..', 'vendor', 'chrome-win64', 'chrome.exe'));
  } catch (_) {}
  try {
    list.push(path.join(process.cwd(), 'data', 'chrome', 'chrome.exe'));
    list.push(path.join(process.cwd(), 'chrome', 'chrome.exe'));
  } catch (_) {}
  return list;
}

function bundledChromedriver() {
  const list = [];
  try {
    const exeDir = path.dirname(process.execPath);
    list.push(path.join(exeDir, 'chromedriver', 'chromedriver.exe'));
    list.push(path.join(exeDir, 'resources', 'chromedriver', 'chromedriver.exe'));
  } catch (_) {}
  try {
    list.push(path.join(__dirname, '..', 'data', 'chromedriver', 'chromedriver.exe'));
    list.push(path.join(__dirname, '..', 'chromedriver', 'chromedriver.exe'));
    list.push(path.join(__dirname, '..', 'vendor', 'chromedriver', 'chromedriver.exe'));
  } catch (_) {}
  const hit = list.find(exists);
  return hit || '';
}

function findBundledChrome() {
  for (const p of bundledPaths()) if (exists(p)) return p;
  return '';
}

function findChrome() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find(exists) || '';
}

function findEdge() {
  if (process.platform !== 'win32') return '';
  const candidates = [
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return candidates.find(exists) || '';
}

function detectChromium() {
  const chrome = findChrome();
  if (chrome) return { path: chrome, type: 'chrome' };
  const edge = findEdge();
  if (edge) return { path: edge, type: 'edge' };
  return null;
}

function detectViaWhere() {
  return new Promise((resolve) => {
    execFile('where', ['chrome'], (err, stdout) => {
      if (!err && stdout) {
        const first = String(stdout).split(/\r?\n/).find(Boolean);
        if (first) return resolve(first.trim());
      }
      resolve('');
    });
  });
}

function regQueryChrome() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      '/ve'
    ], (err, stdout) => {
      if (err) return resolve('');
      const m = String(stdout).match(/REG_SZ\s+(.+)/);
      const p = m ? m[1].trim() : '';
      resolve(p && exists(p) ? p : '');
    });
  });
}

module.exports = { findChrome, findEdge, detectChromium, detectViaWhere, regQueryChrome, findBundledChrome, bundledChromedriver, bundledPaths, exists };
