const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { detectChromium, detectViaWhere, regQueryChrome, findBundledChrome, bundledChromedriver, exists } = require('./detect');
const { extractUid } = require('./importer');
const { fmtDate, toCdpCookies } = require('./exporter');
const { twoFaForClipboard } = require('./totp');
const { sleep, rand, delay, typeHuman } = require('./human');
const { isHarmlessCheckpointSrc, checkpointFromUrl } = require('./fburl');

const FB_HOME = 'https://www.facebook.com/';
const FB_LOGIN = 'https://www.facebook.com/login/';

function nowIso() {
  return new Date().toISOString();
}

class ChromeManager {
  constructor(store, emit, profilesRoot) {
    this.store = store;
    this.emit = emit;
    this.profilesRoot = profilesRoot;
    this.drivers = new Map();
    this.keepOpen = new Set();
    this.chromePath = '';
    this.queue = [];
    this.reserved = new Set();
    this.logs = [];
  }

  runningIds() {
    return [...this.drivers.keys()];
  }

  queuedIds() {
    return this.queue.map((x) => x.id);
  }

  concurrency() {
    const n = Number((this.store.getSettings() || {}).threads);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(20, Math.floor(n));
  }

  hideBrowser() {
    return !!(this.store.getSettings() || {}).hideBrowser;
  }

  activeCount() {
    return this.reserved.size;
  }

  status(id, message) {
    const entry = { id: id || '', message: String(message || ''), time: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs = this.logs.slice(-300);
    this.emit('status', entry);
    this.emit('log:append', entry);
  }

  recentLogs() {
    return this.logs.slice(-200);
  }

  clearLogs() {
    this.logs = [];
    this.emit('log:cleared');
    return { ok: true };
  }

  async resolveChrome() {
    const eng = String((this.store.getSettings().chromeEngine || 'bundled')).trim().toLowerCase();
    const preferBundled = eng !== 'system';
    if (preferBundled) {
      const bundled = findBundledChrome();
      if (bundled) { this.chromePath = bundled; return bundled; }
    }
    // system mode: ưu tiên chromePath người dùng trước, rồi mới fallback bundled
    if (this.chromePath && fs.existsSync(this.chromePath)) return this.chromePath;
    const settingPath = (this.store.getSettings().chromePath || '').trim();
    if (settingPath && fs.existsSync(settingPath)) {
      this.chromePath = settingPath;
      return this.chromePath;
    }
    if (!preferBundled) {
      // system được chọn mà không có settingPath -> thử bundled như fallback
      const bundled2 = findBundledChrome();
      if (bundled2) { this.chromePath = bundled2; return bundled2; }
    }
    const found = detectChromium();
    if (found) {
      this.chromePath = found.path;
      return this.chromePath;
    }
    const reg = await regQueryChrome();
    if (reg) {
      this.chromePath = reg;
      return this.chromePath;
    }
    this.chromePath = await detectViaWhere();
    return this.chromePath;
  }

  profileDir(account) {
    return path.join(this.profilesRoot, account.id);
  }

  async open(account, opts = {}) {
    const mode = String((opts && opts.mode) || 'openOnly').trim() || 'openOnly';
    const keepOpen = !!(opts && opts.keepOpen);
    if (keepOpen && (this.drivers.has(account.id) || this.reserved.has(account.id))) this.keepOpen.add(account.id);
    if (this.drivers.has(account.id) || this.reserved.has(account.id)) {
      this.status(account.id, 'Chrome đã mở sẵn');
      return { ok: true, already: true };
    }
    if (this.queue.some((x) => x.id === account.id)) {
      this.status(account.id, 'Đang chờ luồng trống...');
      return { ok: true, queued: true };
    }
    if (this.activeCount() >= this.concurrency()) {
      this.queue.push({ id: account.id, mode, keepOpen });
      this.status(account.id, `Hàng chờ (${this.queue.length}) — tối đa ${this.concurrency()} luồng.`);
      return { ok: true, queued: true };
    }
    // Non-blocking: reserve slot and launch in background so IPC không treo UI.
    this.reserved.add(account.id);
    this.store.update(account.id, { status: 'running' });
    this.emit('accounts:changed');
    this.status(account.id, `Đang mở Chrome... (${mode})`);
    setImmediate(() => {
      this.spawnNow(account, { mode, keepOpen }).catch((err) => {
        this.reserved.delete(account.id);
        this.drivers.delete(account.id);
        this.keepOpen.delete(account.id);
        const current = this.store.get(account.id);
        if (current && current.status === 'running') {
          this.store.update(account.id, { status: 'idle' });
          this.emit('accounts:changed');
        }
        this.status(account.id, 'Không mở được Chrome: ' + (err.message || err));
        this.pump();
      });
    });
    return { ok: true, started: true };
  }

  pump() {
    while (this.queue.length && this.activeCount() < this.concurrency()) {
      const item = this.queue.shift();
      const account = this.store.get(item.id);
      if (!account) continue;
      if (this.drivers.has(account.id) || this.reserved.has(account.id)) continue;
      this.spawn(account, { mode: item.mode || 'openOnly', keepOpen: item.keepOpen }).catch((err) => {
        this.reserved.delete(account.id);
        this.status(account.id, 'Không mở được Chrome: ' + (err.message || err));
        this.pump();
      });
    }
  }

  async spawn(account, opts = {}) {
    // kept for pump() / legacy callers; open() now inlines reserved+emit and uses setImmediate+spawnNow
    this.reserved.add(account.id);
    try {
      return await this.spawnNow(account, opts);
    } catch (err) {
      this.reserved.delete(account.id);
      this.drivers.delete(account.id);
      this.keepOpen.delete(account.id);
      return { ok: false, error: String(err.message || err) };
    }
  }

  seleniumManagerPath() {
    const fromEnv = String(process.env.SE_MANAGER_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const packed = path.join(
      path.dirname(require.resolve('selenium-webdriver/package.json')),
      'bin',
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      process.platform === 'win32' ? 'selenium-manager.exe' : 'selenium-manager'
    );
    const unpacked = packed.includes(`${path.sep}app.asar${path.sep}`)
      ? packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
      : packed;
    if (fs.existsSync(unpacked)) return unpacked;
    return fs.existsSync(packed) && !packed.includes(`${path.sep}app.asar${path.sep}`) ? packed : '';
  }

  async spawnNow(account, opts = {}) {
    const mode = String((opts && opts.mode) || 'openOnly').trim() || 'openOnly';
    if (opts && opts.keepOpen) this.keepOpen.add(account.id);
    else this.keepOpen.delete(account.id);
    const exe = await this.resolveChrome();
    const bundledPath = (findBundledChrome() || '').toLowerCase();
    const isBundled = bundledPath && String(exe || '').toLowerCase() === bundledPath;
    if (!exe) {
      this.reserved.delete(account.id);
      const cur0 = this.store.get(account.id);
      if (cur0 && cur0.status === 'running') { this.store.update(account.id, { status: 'idle' }); this.emit('accounts:changed'); }
      this.status(account.id, 'Không tìm thấy Chrome. Cài Chrome hoặc đặt vendor/chrome.');
      this.pump();
      return { ok: false, error: 'Không tìm thấy Chrome. Cài Chrome hoặc đặt vendor/chrome.' };
    }

    const driverBin = isBundled ? bundledChromedriver() : '';
    const manager = isBundled && driverBin ? '' : this.seleniumManagerPath();
    if (!isBundled) {
      if (manager) process.env.SE_MANAGER_PATH = manager;
      else {
        this.reserved.delete(account.id);
        const cur0b = this.store.get(account.id);
        if (cur0b && cur0b.status === 'running') { this.store.update(account.id, { status: 'idle' }); this.emit('accounts:changed'); }
        this.status(account.id, 'Không tìm thấy selenium-manager.exe (asar unpacked). Build lại exe.');
        this.pump();
        return { ok: false, error: 'Không tìm thấy selenium-manager.exe (asar unpacked). Build lại exe.' };
      }
    } else if (driverBin) {
      process.env.SE_CHROMEDRIVER = driverBin;
    }

    const profileDir = this.profileDir(account);
    fs.mkdirSync(profileDir, { recursive: true });
    const hidden = this.hideBrowser();

    // store already set to running by open(); keep idempotent
    if ((this.store.get(account.id) || {}).status !== 'running') {
      this.store.update(account.id, { status: 'running' });
      this.emit('accounts:changed');
    }

    const options = new chrome.Options();
    options.setChromeBinaryPath(exe);
    options.addArguments(
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=ChromeWhatsNewUI',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-blink-features=AutomationControlled',
      '--lang=vi-VN,vi,en-US,en'
    );
    options.excludeSwitches('enable-automation');
    options.setUserPreferences({
      credentials_enable_service: false,
      'profile.password_manager_enabled': false,
      'profile.default_content_setting_values.notifications': 2
    });
    if (hidden) {
      options.addArguments('--headless=new', '--disable-gpu', '--window-size=1280,800');
    }

    this.status(account.id, `Đang mở Chrome Selenium${hidden ? ' ẩn' : ''}... (${mode})`);
    let driver;
    const svc = driverBin ? new chrome.ServiceBuilder(driverBin) : null;
    let builder = new Builder().forBrowser('chrome').setChromeOptions(options);
    if (svc) builder = builder.setChromeService(svc);
    try {
      driver = await builder.build();
    } catch (err) {
      this.reserved.delete(account.id);
      this.keepOpen.delete(account.id);
      const cur = this.store.get(account.id);
      if (cur && cur.status === 'running') { this.store.update(account.id, { status: 'idle' }); this.emit('accounts:changed'); }
      this.status(account.id, 'Không mở được Chrome: ' + (err.message || err));
      this.pump();
      return { ok: false, error: String(err.message || err) };
    }

    this.drivers.set(account.id, driver);
    driver.getSession().then(() => {}).catch(() => {});

    this.watchQuit(account.id, driver);
    if (mode === 'openOnly') {
      try {
        await driver.get(FB_HOME);
        this.status(account.id, 'Đã mở trình duyệt — tự đăng nhập/ thao tác tay.');
      } catch (err) {
        this.status(account.id, 'Mở trình duyệt lỗi: ' + (err.message || err));
      }
    } else {
      this.loginFlow(account.id, driver, mode).catch((err) => {
        this.status(account.id, 'Login flow lỗi: ' + (err.message || err));
      });
    }

    return { ok: true, hidden };
  }

  watchQuit(id, driver) {
    const timer = setInterval(async () => {
      if (this.drivers.get(id) !== driver) {
        clearInterval(timer);
        return;
      }
      try {
        await driver.getTitle();
      } catch (_) {
        clearInterval(timer);
        if (this.drivers.get(id) === driver) this.release(id, 'Chrome đã đóng.');
      }
    }, 2500);
  }

  release(id, message) {
    const had = this.drivers.has(id) || this.reserved.has(id);
    this.drivers.delete(id);
    this.reserved.delete(id);
    this.keepOpen.delete(id);
    if (!had) {
      this.pump();
      return;
    }
    const current = this.store.get(id);
    if (current && current.status === 'running') {
      this.store.update(id, { status: 'idle' });
      this.emit('accounts:changed');
    }
    if (message) this.status(id, message);
    this.pump();
  }

  copyTwoFa(account) {
    const fa = twoFaForClipboard(account.twoFa);
    if (!fa.text) return fa;
    try { clipboard.writeText(fa.text); } catch (_) { /* ignore */ }
    return fa;
  }

  async loginFlow(accountId, driver, mode) {
    const m = String(mode || 'uidPass').trim() || 'uidPass';
    const account = this.store.get(accountId);
    if (!account) return;

    if (m === 'cookie') {
      const cookies = toCdpCookies(account);
      if (!cookies.length) {
        this.status(accountId, 'Không có cookie — không đăng nhập cookie được. Dùng UID/Pass hoặc mở trình duyệt.');
        await driver.get(FB_LOGIN);
        await delay();
        return;
      }
      this.status(accountId, 'Đăng nhập bằng cookie — đang thêm cookie...');
      await driver.get(FB_HOME);
      await delay();
      await this.addCookies(driver, cookies);
      await sleep(rand(1200, 2000));
      await driver.get(FB_HOME);
      await sleep(rand(2500, 4000));
      if (await this.applyCheckpoint(accountId, driver)) return;
      if (await this.waitSessionLive(driver, 12000)) {
        await this.markLive(accountId, driver);
        return;
      }
      this.status(accountId, 'Cookie không vào được — giữ nguyên trang, không tự chuyển sang UID/Pass.');
      return;
    }

    // m === 'uidPass' : xoá cookie trình duyệt trước rồi login UID/Pass (+2FA)
    this.status(accountId, `Đăng nhập UID/Pass: ${account.uid || account.email || account.id}`);
    const cleared = await this.gotoLoginFresh(driver);
    if (cleared) this.status(accountId, 'Đã xoá cookie trình duyệt, vào trang login mới.');
    await delay();
    if (await this.applyCheckpoint(accountId, driver)) return;

    if (await this.sessionIsLive(driver)) {
      await this.markLive(accountId, driver);
      return;
    }

    if (!(await this.isLoginPage(driver))) {
      this.status(accountId, 'Load lại trang login để điền uid/pass.');
      await driver.get(FB_LOGIN);
      await delay();
      if (await this.applyCheckpoint(accountId, driver)) return;
    }

    if (await this.isLoginPage(driver)) {
      const submitted = await this.submitLogin(driver, account);
      if (!submitted) {
        if (!account.password) this.status(accountId, 'Đang ở trang login. Điền tay hoặc import kèm pass.');
        else this.status(accountId, 'Không thấy nút Log in (aria-label). Kiểm tra cửa sổ Chrome.');
        return;
      }
    }

    this.status(accountId, 'Đã bấm Log in, chờ Facebook phản hồi...');
    let phase = await this.waitLoginResult(driver, 25000);

    if (phase === 'wrong_pass') {
      this.markDead(accountId, 'Sai Pass');
      return;
    }
    if (phase === 'checkpoint') {
      if (await this.applyCheckpoint(accountId, driver)) return;
    }

    if (phase === 'remember' || await this.isRememberBrowserPage(driver)) {
      const done = await this.skipRememberBrowser(accountId, driver);
      if (done) return;
    }

    if (phase === 'two_factor' || await this.isTwoFactorPage(driver)) {
      if (await this.isRememberBrowserPage(driver)) {
        const done = await this.skipRememberBrowser(accountId, driver);
        if (done) return;
      } else {
        this.status(accountId, 'Facebook hỏi 2FA — không reload trang.');
        const ok2fa = await this.handleTwoFactor(driver, account);
        if (ok2fa) this.status(accountId, 'Đã nhập mã 2FA, chờ trang chuyển...');
        else this.status(accountId, 'Chưa điền được 2FA — giữ nguyên trang, nhập tay nếu cần.');
        phase = await this.waitAfterTwoFactor(driver, 35000);
        if (phase === 'remember' || await this.isRememberBrowserPage(driver)) {
          const done = await this.skipRememberBrowser(accountId, driver);
          if (done) return;
        }
        if (phase === 'two_factor' && await this.isTwoFactorPage(driver)) {
          this.status(accountId, 'Vẫn ở trang 2FA — không load lại. Nhập mã tay nếu cần.');
          return;
        }
      }
    }

    if (await this.applyCheckpoint(accountId, driver)) return;

    const url = await this.pageUrl(driver);
    if (/consent/i.test(url)) {
      this.status(accountId, 'Check Point Allow all cookies');
      await this.clickCss(driver, '[aria-label="Allow all cookies"], [aria-label="Cho phép tất cả cookie"]');
      await delay();
    }

    if (await this.isRememberBrowserPage(driver)) {
      const done = await this.skipRememberBrowser(accountId, driver);
      if (done) return;
    }
    if (await this.isLoggedIn(driver)) {
      await this.markLive(accountId, driver);
      return;
    }
    if (await this.isTwoFactorPage(driver)) {
      this.status(accountId, 'Đang chờ 2FA — giữ nguyên trang.');
      return;
    }
    if (await this.hasLoginButton(driver) && await this.isLoginPage(driver)) {
      this.markDead(accountId, 'Login xịt — login tay.');
      return;
    }
    this.status(accountId, 'Chưa vào home — giữ nguyên trang, không reload.');
  }

  async waitLoginResult(driver, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = await this.pageUrl(driver);
      if (/login_attempt/i.test(url)) return 'wrong_pass';
      if (/remember_browser/i.test(url)) return 'remember';
      if (await this.isTwoFactorPage(driver)) return 'two_factor';
      const cp = checkpointFromUrl(url);
      if (cp && cp.code !== '049' && cp.code !== 'consent') return 'checkpoint';
      if (await this.isLoggedIn(driver)) return 'live';
      await sleep(1000);
    }
    if (/remember_browser/i.test(await this.pageUrl(driver))) return 'remember';
    if (await this.isTwoFactorPage(driver)) return 'two_factor';
    if (await this.isLoggedIn(driver)) return 'live';
    return 'unknown';
  }

  async waitAfterTwoFactor(driver, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = await this.pageUrl(driver);
      if (/remember_browser/i.test(url)) return 'remember';
      if (/login_attempt/i.test(url)) return 'wrong_pass';
      const cp = checkpointFromUrl(url);
      if (cp && cp.code !== '049' && cp.code !== 'consent') return 'checkpoint';
      if (isHarmlessCheckpointSrc(url) || await this.isLoggedIn(driver)) return 'live';
      const stillTwoFa = /two_step_verification|two_factor/i.test(url) || await this.isTwoFactorPage(driver);
      if (!stillTwoFa) {
        if (await this.isLoggedIn(driver)) return 'live';
        return 'unknown';
      }
      await sleep(800);
    }
    if (/remember_browser/i.test(await this.pageUrl(driver))) return 'remember';
    if (await this.isLoggedIn(driver)) return 'live';
    if (await this.isTwoFactorPage(driver)) return 'two_factor';
    return 'unknown';
  }

  async clearFacebookCookies(driver) {
    try { await driver.manage().deleteAllCookies(); } catch (_) { /* ignore */ }
    try {
      const left = await driver.manage().getCookies();
      for (const c of left || []) {
        try { await driver.manage().deleteCookie(c.name); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    try {
      await driver.executeScript(`
        try { localStorage.clear(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        (document.cookie || '').split(';').forEach((part) => {
          const name = part.split('=')[0].trim();
          if (!name) return;
          const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
          document.cookie = name + '=;' + expires + ';path=/';
          document.cookie = name + '=;' + expires + ';path=/;domain=.facebook.com';
          document.cookie = name + '=;' + expires + ';path=/;domain=facebook.com';
        });
      `);
    } catch (_) { /* ignore */ }
  }

  async hasLoggedInUi(driver) {
    try {
      return !!(await driver.executeScript(`
        const q = (s) => document.querySelector(s);
        if (q('#email') || q('#loginform') || q('input[name="email"]')) return false;
        const sels = [
          '[aria-label="Your profile"]',
          '[aria-label="Trang cá nhân của bạn"]',
          '[aria-label="Account Controls and Settings"]',
          '[aria-label="Controls and Settings"]',
          'div[role="banner"] [aria-label="Home"]',
          'div[role="banner"] [aria-label="Trang chủ"]',
          'a[href="/notifications/"]',
          'div[role="feed"]',
          '[data-pagelet="LeftRail"]'
        ];
        return sels.some((s) => !!q(s));
      `));
    } catch (_) {
      return false;
    }
  }

  async sessionIsLive(driver) {
    if (await this.isTwoFactorPage(driver) || await this.isRememberBrowserPage(driver)) return false;
    if (await this.isLoginPage(driver)) return false;
    const url = await this.pageUrl(driver);
    if (/\/login/i.test(url) && !/two_factor/i.test(url)) return false;
    const hasEmail = !!(await this.findFirst(driver, [By.id('email'), By.name('email'), By.id('loginform')], 0));
    if (hasEmail) return false;
    return await this.hasLoggedInUi(driver);
  }

  async waitSessionLive(driver, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.sessionIsLive(driver)) return true;
      if (await this.isLoginPage(driver)) return false;
      await sleep(800);
    }
    return await this.sessionIsLive(driver);
  }

  async addCookies(driver, cookies) {
    for (const c of cookies) {
      const payload = {
        name: c.name,
        value: String(c.value == null ? '' : c.value),
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly
      };
      if (c.expires && c.expires > 0) payload.expiry = Math.floor(c.expires);
      try {
        await driver.manage().addCookie(payload);
      } catch (_) {
        try {
          payload.domain = 'facebook.com';
          await driver.manage().addCookie(payload);
        } catch (__) { /* skip bad cookie */ }
      }
    }
  }

  async applyCheckpoint(accountId, driver) {
    const url = await this.pageUrl(driver);
    if (isHarmlessCheckpointSrc(url)) return false;
    const info = checkpointFromUrl(url);
    if (!info) return false;
    if (info.code === '049') {
      this.status(accountId, 'Check Point 049, đang gỡ');
      const clicked = await this.clickTextButton(driver, ['Bỏ qua', 'Skip', 'Dismiss', 'Không phải bây giờ', 'Để sau', 'Not now', 'Later']);
      if (clicked) {
        this.status(accountId, 'CP 049: đã bấm "Bỏ qua".');
      } else {
        const viaAria = await this.clickCss(driver, '[aria-label="Dismiss"], [aria-label="Đóng"], [aria-label="Bỏ qua"], [aria-label="Skip"]');
        this.status(accountId, viaAria ? 'CP 049: đã bấm nút Dismiss (aria-label).' : 'CP 049: không thấy nút Bỏ qua — kiểm tra cửa sổ Chrome.');
      }
      await sleep(rand(1500, 3000));
      return false;
    }
    if (info.code === 'consent') {
      this.status(accountId, 'Check Point Allow all cookies');
      await this.clickCss(driver, '[aria-label="Allow all cookies"], [aria-label="Cho phép tất cả cookie"]');
      await sleep(rand(800, 1500));
      return false;
    }
    this.markCheckpoint(accountId, info.code === 'checkpoint' ? '' : info.code);
    this.status(accountId, info.code === 'checkpoint'
      ? 'Checkpoint — dừng đăng nhập.'
      : `Check Point ${info.code} — dừng đăng nhập.`);
    return true;
  }

  markCheckpoint(id, code) {
    this.store.update(id, {
      status: 'checkpoint',
      checkpointCode: code || '',
      lastCheck: nowIso()
    });
    this.emit('accounts:changed');
  }

  markDead(id, reason) {
    this.store.update(id, { status: 'dead', lastCheck: nowIso() });
    this.emit('accounts:changed');
    this.status(id, reason);
  }

  async markLive(id, driver) {
    try { await this.capture(id, driver, { replace: true }); } catch (_) { /* ignore */ }
    this.store.update(id, { status: 'live', lastCheck: nowIso(), checkpointCode: '' });
    this.status(id, 'Đăng nhập thành công. Cookie đã lưu (thay cookie cũ nếu có).');
    if (this.keepOpen.has(id)) {
      this.keepOpen.delete(id);
      this.status(id, 'Giữ trình duyệt mở theo yêu cầu — tắt tay khi xong.');
      return;
    }
    this.status(id, 'Đóng trình duyệt.');
    this.closeById(id, { keepStatus: true });
  }

  async gotoLoginFresh(driver) {
    try {
      await driver.get(FB_HOME);
      await this.clearFacebookCookies(driver);
      await driver.get(FB_LOGIN);
      return true;
    } catch (_) {
      try { await driver.get(FB_LOGIN); } catch (_) { /* ignore */ }
      return false;
    }
  }

  async pageUrl(driver) {
    try { return String(await driver.getCurrentUrl() || ''); }
    catch (_) { return ''; }
  }

  async isLoginPage(driver) {
    if (await this.isTwoFactorPage(driver)) return false;
    const url = await this.pageUrl(driver);
    if (/\/login/i.test(url) && !/two_factor|checkpoint/i.test(url)) return true;
    return !!(await this.findFirst(driver, [By.id('email'), By.name('email'), By.id('loginform')], 0));
  }

  async isRememberBrowserPage(driver) {
    return /remember_browser/i.test(await this.pageUrl(driver));
  }

  async isTwoFactorPage(driver) {
    const url = await this.pageUrl(driver);
    if (/remember_browser/i.test(url)) return false;
    if (await this.isRememberBrowserPage(driver)) return false;
    if (/two_step_verification|two_factor/i.test(url) && !/remember_browser/i.test(url)) return true;
    return !!(await this.findTwoFactorInput(driver, 0));
  }

  async skipRememberBrowser(accountId, driver) {
    this.status(accountId, 'Trang remember_browser — bỏ qua Trust device, vào facebook.com.');
    await driver.get(FB_HOME);
    await sleep(rand(1200, 2200));
    if (await this.applyCheckpoint(accountId, driver)) return true;
    if (await this.isLoggedIn(driver)) {
      await this.markLive(accountId, driver);
      return true;
    }
    this.status(accountId, 'Đã rời remember_browser, kiểm tra trạng thái...');
    return false;
  }

  async isLoggedIn(driver) {
    if (await this.isRememberBrowserPage(driver)) return false;
    if (await this.isTwoFactorPage(driver)) return false;
    if (await this.isLoginPage(driver)) return false;
    const url = await this.pageUrl(driver);
    if (/\/login/i.test(url) && !/two_factor/i.test(url)) return false;
    const cp = checkpointFromUrl(url);
    if (cp && cp.code !== '049' && cp.code !== 'consent') return false;
    if (await this.hasLoggedInUi(driver)) return true;
    if (isHarmlessCheckpointSrc(url) || /home\.php/i.test(url)) {
      try {
        const cookies = await driver.manage().getCookies();
        if (cookies.some((c) => c.name === 'c_user' && /facebook/i.test(c.domain || ''))) return true;
      } catch (_) { /* fall through */ }
    }
    try {
      const cookies = await driver.manage().getCookies();
      return cookies.some((c) => c.name === 'c_user' && /facebook/i.test(c.domain || ''));
    } catch (_) {
      return false;
    }
  }

  async hasLoginButton(driver) {
    if (await this.isRememberBrowserPage(driver) || await this.isTwoFactorPage(driver)) return false;
    return !!(await this.findFirst(driver, this.loginButtonLocators(), 600));
  }

  loginButtonLocators() {
    return [
      By.css('div[aria-label="Log in"][role="button"]'),
      By.css('[aria-label="Log in"]'),
      By.css('[aria-label="Log In"]'),
      By.css('[aria-label="Đăng nhập"]'),
      By.css('[aria-label="Accessible login button"]'),
      By.name('login'),
      By.id('loginbutton'),
      By.css('button[name="login"]'),
      By.css('button[type="submit"]')
    ];
  }

  async findFirst(driver, locators, timeoutMs = 800) {
    for (const by of locators) {
      try {
        const found = await driver.findElements(by);
        if (found && found.length) return found[0];
      } catch (_) { /* try next */ }
    }
    if (!timeoutMs) return null;
    const first = locators[0];
    if (!first) return null;
    try {
      return await driver.wait(until.elementLocated(first), timeoutMs);
    } catch (_) {
      return null;
    }
  }

  async clickCss(driver, selector) {
    try {
      const el = await driver.wait(until.elementLocated(By.css(selector)), 4000);
      await el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  async findTwoFactorInput(driver, timeoutMs = 0) {
    const scan = async () => {
      try {
        return await driver.executeScript(`
          const vis = (n) => {
            if (!n) return false;
            const st = window.getComputedStyle(n);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            if (n.disabled) return false;
            const r = n.getBoundingClientRect();
            return r.width > 8 && r.height > 8;
          };
          const labelText = (el) => {
            const id = el.id || '';
            const lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
            return ((lab && (lab.innerText || lab.textContent)) || el.getAttribute('aria-label') || el.placeholder || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          };
          const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
          const skip = (el) => {
            const t = (el.type || '').toLowerCase();
            const name = (el.name || el.id || '').toLowerCase();
            return t === 'password' || t === 'hidden' || t === 'checkbox' || t === 'radio' || t === 'submit'
              || name === 'email' || name === 'pass' || name === 'login';
          };
          const ranked = [];
          for (const el of inputs) {
            if (skip(el)) continue;
            const lab = labelText(el);
            const type = (el.type || 'text').toLowerCase();
            let score = 100;
            if (/^(code|mã|ma)$/.test(lab) || lab === 'enter code') score = 0;
            else if (/code|mã|otp|2fa|authentication/.test(lab)) score = 10;
            else if (el.autocomplete === 'one-time-code' || el.name === 'approvals_code' || el.id === 'approvals_code') score = 5;
            else if (type === 'tel' || el.inputMode === 'numeric') score = 20;
            else if (type === 'text') score = 40;
            else continue;
            ranked.push({ el, score });
          }
          ranked.sort((a, b) => a.score - b.score);
          if (ranked.length && ranked[0].score <= 40) return ranked[0].el;
          const texts = inputs.filter((el) => !skip(el) && ((el.type || 'text').toLowerCase() === 'text'));
          return texts.length === 1 ? texts[0] : null;
        `);
      } catch (_) {
        return null;
      }
    };
    const first = await scan();
    if (first || !timeoutMs) return first;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await scan();
      if (found) return found;
      await sleep(300);
    }
    return scan();
  }

  async roleButtons(driver) {
    try {
      return await driver.findElements(By.css('[role="button"]'));
    } catch (_) {
      return [];
    }
  }

  async fillTwoFactorCode(driver, input, code) {
    const text = String(code || '');
    if (!input || !text) return false;
    try { await this.realClick(driver, input); } catch (_) { /* ignore */ }
    await sleep(rand(200, 400));
    try { await input.clear(); } catch (_) { /* ignore */ }
    try {
      await driver.executeScript('arguments[0].value = ""; arguments[0].focus();', input);
    } catch (_) { /* ignore */ }
    try {
      await typeHuman(input, text);
    } catch (_) {
      try { await input.sendKeys(text); } catch (__) { /* ignore */ }
    }
    let value = '';
    try { value = await input.getAttribute('value'); } catch (_) { /* ignore */ }
    if (value !== text) {
      try {
        await driver.executeScript(`
          const el = arguments[0];
          const val = arguments[1];
          const proto = window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        `, input, text);
      } catch (_) { /* ignore */ }
    }
    try { value = await input.getAttribute('value'); } catch (_) { /* ignore */ }
    return value === text || String(value || '').replace(/\s+/g, '') === text;
  }

  async findLabeled(driver, labels) {
    const needles = (labels || []).map((s) => String(s).trim()).filter(Boolean);
    if (!needles.length) return null;
    try {
      return await driver.executeScript(`
        const needles = (arguments[0] || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
        const vis = (node) => {
          if (!node) return false;
          const st = window.getComputedStyle(node);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          const r = node.getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        };
        const disabled = (node) => !!(node.disabled || node.getAttribute('aria-disabled') === 'true' || node.closest('[aria-disabled="true"], [disabled]'));
        const ownText = (node) => {
          const label = (node.getAttribute('aria-label') || '').trim();
          let text = '';
          for (const child of node.childNodes) {
            if (child.nodeType === 3) text += child.textContent || '';
          }
          text = (text + ' ' + label).replace(/\\s+/g, ' ').trim().toLowerCase();
          if (text) return text;
          return ((node.innerText || node.textContent || '') + ' ' + label).replace(/\\s+/g, ' ').trim().toLowerCase();
        };
        const fullText = (node) => ((node.innerText || node.textContent || '') + ' ' + (node.getAttribute('aria-label') || ''))
          .replace(/\\s+/g, ' ').trim().toLowerCase();
        const match = (raw) => needles.find((n) => raw === n || raw.startsWith(n + ' ') || raw.startsWith(n));
        const ranked = [];
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, label, a[href], [role="radio"], [role="link"]'));
        for (const node of nodes) {
          if (!vis(node) || disabled(node)) continue;
          const raw = fullText(node);
          if (!raw || raw.length > 180) continue;
          const needle = match(raw);
          if (!needle) continue;
          const exact = raw === needle || ownText(node) === needle;
          const role = (node.getAttribute('role') || '').toLowerCase();
          const score = (exact ? 0 : 30) + raw.length + (role === 'button' || node.tagName === 'BUTTON' ? 0 : 10);
          ranked.push({ node, score });
        }
        ranked.sort((a, b) => a.score - b.score);
        if (ranked.length) return ranked[0].node;
        for (const node of Array.from(document.querySelectorAll('span'))) {
          if (!vis(node)) continue;
          const raw = fullText(node);
          if (!needles.some((n) => raw === n)) continue;
          const btn = node.closest('[role="button"], button, label, a, [role="radio"]');
          if (btn && vis(btn) && !disabled(btn)) return btn;
        }
        return null;
      `, needles);
    } catch (_) {
      return null;
    }
  }

  // Tìm nút theo text (kể cả chuỗi div role="none" lồng nhau của FB CP 049),
  // leo lên container có lớp phủ data-visualcompletion="ignore" để realClick bấm được.
  async clickTextButton(driver, labels) {
    const needles = (labels || []).map((s) => String(s).trim()).filter(Boolean);
    if (!needles.length) return false;
    let el = null;
    try {
      el = await driver.executeScript(`
        const needles = (arguments[0] || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
        const vis = (n) => {
          if (!n) return false;
          const st = window.getComputedStyle(n);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          const r = n.getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        };
        const disabled = (n) => !!(n.disabled || n.getAttribute('aria-disabled') === 'true' || n.closest('[aria-disabled="true"], [disabled]'));
        const text = (n) => ((n.innerText || n.textContent || '') + ' ' + (n.getAttribute('aria-label') || ''))
          .replace(/\\s+/g, ' ').trim().toLowerCase();
        const matchNeedle = (raw) => needles.find((x) => raw === x || raw.startsWith(x + ' ') || raw.startsWith(x));

        // 1) Ưu tiên nút thật có text/aria-label khớp
        const real = Array.from(document.querySelectorAll('[role="button"], button, a[href], [role="link"]'));
        const ranked = [];
        for (const n of real) {
          if (!vis(n) || disabled(n)) continue;
          const raw = text(n);
          if (!raw || raw.length > 120) continue;
          const needle = matchNeedle(raw);
          if (!needle) continue;
          const score = (raw === needle ? 0 : 40) + raw.length;
          ranked.push({ n, score });
        }
        ranked.sort((a, b) => a.score - b.score);
        if (ranked.length) return ranked[0].n;

        // 2) FB CP 049: text nằm trong span, toàn bộ container là div role="none"
        for (const n of Array.from(document.querySelectorAll('span, div'))) {
          if (!vis(n) || disabled(n)) continue;
          const own = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          if (!own || own.length > 60) continue;
          if (!needles.some((x) => own === x || own.startsWith(x + ' ') || own.startsWith(x))) continue;
          // leo lên tới container chứa lớp phủ data-visualcompletion="ignore"
          let box = n;
          for (let i = 0; i < 8 && box; i++) {
            if (box.querySelector && box.querySelector('[data-visualcompletion="ignore"]')) return box;
            box = box.parentElement;
          }
          return n.closest('[role="button"], button, a') || n;
        }
        return null;
      `, needles);
    } catch (_) {
      return false;
    }
    if (!el) return false;
    return this.realClick(driver, el);
  }

  async realClick(driver, el) {
    if (!el) return false;
    try {
      await driver.executeScript(
        'arguments[0].scrollIntoView({block:"center",inline:"nearest"}); try { arguments[0].focus({preventScroll:true}); } catch (e) {}',
        el
      );
    } catch (_) { /* ignore */ }
    await sleep(120);

    let overlay = null;
    try {
      overlay = await driver.executeScript(
        'return arguments[0].querySelector("[data-visualcompletion=\\"ignore\\"]") || arguments[0];',
        el
      );
    } catch (_) { /* ignore */ }

    const targets = [];
    if (overlay && overlay !== el) targets.push(overlay);
    targets.push(el);
    for (const target of targets) {
      try {
        await driver.actions({ async: false }).move({ origin: target }).pause(80).click().perform();
        return true;
      } catch (_) { /* ignore */ }
      try {
        await target.click();
        return true;
      } catch (_) { /* intercepted by overlay / not interactable */ }
    }

    try {
      await el.sendKeys(Key.ENTER);
      return true;
    } catch (_) { /* ignore */ }
    try {
      await el.sendKeys(Key.SPACE);
      return true;
    } catch (_) { /* ignore */ }

    try {
      await driver.executeScript(`
        const el = arguments[0];
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 40);
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y) || el;
        top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
        top.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 0 }));
        top.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
      `, overlay || el);
      return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  async clickLabeled(driver, labels) {
    const el = await this.findLabeled(driver, labels);
    if (!el) return '';
    let shown = '';
    try {
      shown = await driver.executeScript(
        'return ((arguments[0].innerText || arguments[0].textContent || "") + "").replace(/\\s+/g, " ").trim();',
        el
      );
    } catch (_) { /* ignore */ }
    const ok = await this.realClick(driver, el);
    return ok ? (shown || (labels && labels[0]) || 'clicked') : '';
  }

  async waitLabeled(driver, labels, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.findLabeled(driver, labels)) return true;
      await sleep(350);
    }
    return !!(await this.findLabeled(driver, labels));
  }

  async waitAndClick(driver, labels, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await this.clickLabeled(driver, labels);
      if (hit) return hit;
      await sleep(450);
    }
    return '';
  }

  async waitTwoFactorInput(driver, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const input = await this.findTwoFactorInput(driver, 0);
      if (input) return input;
      await sleep(400);
    }
    return this.findTwoFactorInput(driver, 0);
  }

  async openTwoFactorCodeForm(driver, accountId) {
    if (await this.waitTwoFactorInput(driver, 1500)) return true;

    this.status(accountId, 'Không thấy ô 2FA — Try another way → Authentication app → Continue.');
    const hasApp = await this.findLabeled(driver, ['Authentication app', 'Ứng dụng xác thực']);
    if (!hasApp) {
      const other = await this.waitAndClick(driver, ['Try another way', 'Thử cách khác'], 8000);
      if (!other) {
        this.status(accountId, 'Không bấm được Try another way.');
        return false;
      }
      this.status(accountId, 'Đã bấm Try another way, chờ danh sách cách xác thực...');
      if (!(await this.waitLabeled(driver, ['Authentication app', 'Ứng dụng xác thực'], 10000))) {
        this.status(accountId, 'Chưa thấy Authentication app — bấm lại Try another way.');
        await this.waitAndClick(driver, ['Try another way', 'Thử cách khác'], 3000);
        if (!(await this.waitLabeled(driver, ['Authentication app', 'Ứng dụng xác thực'], 8000))) {
          this.status(accountId, 'Không thấy Authentication app.');
          return false;
        }
      }
    }

    const picked = await this.waitAndClick(driver, ['Authentication app', 'Ứng dụng xác thực'], 8000);
    if (!picked) {
      this.status(accountId, 'Không chọn được Authentication app.');
      return false;
    }
    this.status(accountId, 'Đã chọn Authentication app.');
    await sleep(rand(500, 900));

    const cont = await this.waitAndClick(driver, ['Continue', 'Tiếp tục', 'Next'], 8000);
    if (cont) this.status(accountId, 'Đã bấm Continue, chờ ô điền 2FA...');
    else this.status(accountId, 'Không bấm được Continue.');
    return !!(await this.waitTwoFactorInput(driver, 15000));
  }

  async submitLogin(driver, account) {
    const user = account.uid || account.email || '';
    const pass = account.password || '';
    if (!user || !pass) return false;
    try {
      const email = await this.findFirst(driver, [By.id('email'), By.name('email'), By.css('input[type="text"]')], 8000);
      const passEl = await this.findFirst(driver, [By.id('pass'), By.name('pass'), By.css('input[type="password"]')], 4000);
      if (!email || !passEl) {
        this.status(account.id, 'Không thấy ô email/pass trên trang login.');
        return false;
      }
      this.status(account.id, 'Đang gõ uid/pass...');
      await typeHuman(email, user);
      await delay();
      await typeHuman(passEl, pass);
      await delay();
      const clicked = await this.clickLoginButton(driver);
      if (!clicked) {
        this.status(account.id, 'Không thấy nút Log in.');
        return false;
      }
      this.status(account.id, 'Đã bấm Log in.');
      return true;
    } catch (err) {
      this.status(account.id, 'Lỗi submit login: ' + (err.message || err));
      return false;
    }
  }

  async clickLoginButton(driver) {
    const btn = await this.findFirst(driver, this.loginButtonLocators(), 5000);
    if (btn) {
      try {
        await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', btn);
        await sleep(rand(200, 400));
        await btn.click();
        return true;
      } catch (_) {
        try {
          await driver.executeScript('arguments[0].click();', btn);
          return true;
        } catch (__) { /* fall through */ }
      }
    }
    try {
      const ok = await driver.executeScript(`
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]'));
        const el = nodes.find((n) => {
          const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')).trim().toLowerCase();
          return label === 'log in' || label === 'login' || label === 'đăng nhập' || label.includes('log in');
        });
        if (!el) return false;
        el.click();
        return true;
      `);
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  async handleTwoFactor(driver, account) {
    if (/remember_browser/i.test(await this.pageUrl(driver))) return false;
    if (await this.isRememberBrowserPage(driver)) return false;

    const fa = this.copyTwoFa(account);
    if (!fa || !fa.text) {
      this.status(account.id, 'Không có secret 2FA — dán mã tay vào ô.');
      return false;
    }

    try {
      const firstButtons = await this.roleButtons(driver);
      if (firstButtons.length === 1) {
        await this.realClick(driver, firstButtons[0]);
        const chk = await this.findFirst(driver, [By.css('[aria-checked="false"]')], 8000);
        if (chk) await this.realClick(driver, chk);
        await sleep(rand(3000, 5000));
        const nexts = await this.roleButtons(driver);
        if (nexts[5]) await this.realClick(driver, nexts[5]);
        else if (nexts[1]) await this.realClick(driver, nexts[1]);
        await sleep(rand(3000, 5000));
      }
    } catch (_) { /* ignore picker extras */ }

    if (!(await this.findTwoFactorInput(driver, 0))) {
      const opened = await this.openTwoFactorCodeForm(driver, account.id);
      if (!opened) this.status(account.id, 'Chưa mở được form 2FA — vẫn chờ ô Code.');
    }

    const input = await this.waitTwoFactorInput(driver, 15000);
    if (!input) {
      this.status(account.id, 'Không thấy ô Code (input type=text) để điền 2FA.');
      return false;
    }

    this.status(account.id, 'Đang nhập mã 2FA...');
    const filled = await this.fillTwoFactorCode(driver, input, fa.text);
    if (!filled) {
      this.status(account.id, 'Gõ mã 2FA thất bại.');
      return false;
    }
    this.status(account.id, 'Nhập mã 2FA hoàn tất');
    await sleep(rand(3000, 5000));

    const deadline = Date.now() + 15000;
    let buttons = await this.roleButtons(driver);
    while (Date.now() < deadline && buttons.length <= 1) {
      await sleep(400);
      buttons = await this.roleButtons(driver);
    }
    if (buttons.length > 1) {
      await this.realClick(driver, buttons[1]);
      this.status(account.id, 'Đang đăng nhập (đã bấm Continue).');
      await sleep(rand(5000, 8000));
      return true;
    }
    const submitted = await this.clickLabeled(driver, ['Continue', 'Tiếp tục', 'Next', 'Submit', 'Đăng nhập']);
    if (submitted) {
      this.status(account.id, 'Đang đăng nhập (đã bấm Continue).');
      await sleep(rand(5000, 8000));
      return true;
    }
    this.status(account.id, 'Không tìm thấy nút tiếp tục.');
    return true;
  }

  async capture(accountId, driver, opts = {}) {
    const all = await driver.manage().getCookies();
    const fbCookies = (all || []).filter((c) =>
      c.domain && (c.domain.includes('facebook.com') || c.domain.includes('messenger.com'))
    );
    if (!fbCookies.length) return false;

    const cookieStr = fbCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const hasCUser = /(?:^|;\s*)c_user=/.test(cookieStr);
    let ua = '';
    try { ua = await driver.executeScript('return navigator.userAgent'); } catch (_) { /* ignore */ }
    const prev = this.store.get(accountId) || {};
    const replace = !!opts.replace;
    if (!hasCUser) {
      if (replace) return false;
      if (/(?:^|;\s*)c_user=/.test(prev.cookie || '')) return false;
    }
    if (!replace && cookieStr === prev.cookie) return false;

    const patch = {
      cookie: cookieStr,
      cookies: fbCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: c.expiry || 0
      })),
      cookieDate: nowIso(),
      userAgent: ua || prev.userAgent || ''
    };

    const uid = extractUid(cookieStr);
    if (uid) {
      patch.uid = uid;
      const clash = this.store.getByUid(uid);
      if (clash && clash.id !== accountId) {
        this.status(accountId, `UID ${uid} đã tồn tại ở nick khác — cookie vẫn lưu nick này.`);
      }
    }
    this.store.update(accountId, patch);
    this.emit('accounts:changed');
    this.status(accountId, `Đã bắt ${fbCookies.length} cookie${hasCUser ? ' (có c_user)' : ''} lúc ${fmtDate(patch.cookieDate)}`);
    return true;
  }

  async captureNow(id) {
    const driver = this.drivers.get(id);
    if (!driver) return { ok: false, error: 'Chrome chưa mở cho nick này' };
    try {
      const saved = await this.capture(id, driver);
      return { ok: true, saved };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  closeById(id, opts = {}) {
    const driver = this.drivers.get(id);
    this.keepOpen.delete(id);
    if (driver) {
      driver.quit().catch(() => {});
    }
    this.drivers.delete(id);
    this.reserved.delete(id);
    this.queue = this.queue.filter((x) => x.id !== id);
    const current = this.store.get(id);
    if (!opts.keepStatus && current && current.status === 'running') {
      this.store.update(id, { status: 'idle' });
    }
    this.emit('accounts:changed');
    this.pump();
    return { ok: true };
  }

  async wipe(id) {
    const driver = this.drivers.get(id);
    this.drivers.delete(id);
    this.reserved.delete(id);
    this.queue = this.queue.filter((x) => x.id !== id);
    if (driver) {
      try { await driver.quit(); } catch (_) { /* ignore */ }
      await sleep(400);
    }
    const dir = path.join(this.profilesRoot, id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this.pump();
    return { ok: true };
  }

  shutdownAll() {
    this.queue = [];
    for (const id of [...this.drivers.keys()]) {
      try { this.closeById(id); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = ChromeManager;
