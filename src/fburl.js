function parseUrl(url) {
  try { return new URL(String(url || '')); }
  catch (_) { return null; }
}

function pathnameOf(url) {
  const u = parseUrl(url);
  if (u) return (u.pathname || '/').replace(/\/+$/, '') || '/';
  const m = String(url || '').match(/^https?:\/\/[^/]+(\/[^?#]*)/i);
  return m ? (m[1].replace(/\/+$/, '') || '/') : '/';
}

function hasCode(url, code) {
  return String(url || '').includes(String(code));
}

function isCheckpointPath(url) {
  const path = pathnameOf(url).toLowerCase();
  return /(^|\/)checkpoint(\/|$)/.test(path);
}

function isHarmlessCheckpointSrc(url) {
  const raw = String(url || '');
  if (!/checkpoint_src=/i.test(raw)) return false;
  if (isCheckpointPath(raw)) return false;
  const path = pathnameOf(raw).toLowerCase();
  return path === '/' || path === '/home.php' || path === '/home';
}

function checkpointFromUrl(url) {
  const raw = String(url || '');
  if (!raw) return null;
  if (isHarmlessCheckpointSrc(raw)) return null;

  const path = pathnameOf(raw).toLowerCase();
  const onCheckpoint = isCheckpointPath(raw);

  if (onCheckpoint && hasCode(raw, '956')) return { code: '956' };
  if (onCheckpoint && hasCode(raw, '282')) return { code: '282' };
  if (onCheckpoint && hasCode(raw, '049')) return { code: '049' };
  if (path.includes('/consent') || /\/consent([/?#]|$)/i.test(raw)) return { code: 'consent' };
  if (onCheckpoint) return { code: 'checkpoint' };
  return null;
}

module.exports = {
  parseUrl,
  pathnameOf,
  hasCode,
  isCheckpointPath,
  isHarmlessCheckpointSrc,
  checkpointFromUrl
};
