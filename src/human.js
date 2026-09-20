function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function delay() {
  return sleep(rand(700, 1800));
}

async function typeHuman(el, text) {
  await el.click();
  try { await el.clear(); } catch (_) { /* ignore */ }
  const str = String(text == null ? '' : text);
  for (const ch of str) {
    await el.sendKeys(ch);
    await sleep(rand(45, 170));
    if (Math.random() < 0.08) await sleep(rand(180, 420));
  }
}

module.exports = { sleep, rand, delay, typeHuman };
