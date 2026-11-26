import { loadData, loadLocal, saveData, addTile, isAddableUrl, matchTile, hostOf, allTiles, collectExtras } from './storage.js';
/* ---------- instalacja: menu kontekstowe i alarmy ---------- */

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sd-page', title: 'Dodaj tę stronę do Mojej Karty', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sd-link', title: 'Dodaj link do Mojej Karty', contexts: ['link'] });
  });
  chrome.alarms.create('gmail', { periodInMinutes: 5, delayInMinutes: 0.1 });
});
chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
  openOnStartup();
  chrome.alarms.create('gmail', { periodInMinutes: 5, delayInMinutes: 0.1 });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const isLink = info.menuItemId === 'sd-link';
  const url = isLink ? info.linkUrl : (tab?.url || info.pageUrl);
  const title = isLink ? (info.selectionText || '') : (tab?.title || '');
  if (!isAddableUrl(url)) return;

  const data = await loadData();
  const g = data.groups.find(x => x.id === data.activeGroup) || data.groups[0];
  if (!g.tiles.some(t => t.url === url)) {
    addTile(data, g.id, { url, title });
    await saveData(data, { syncNow: true });
  }
  if (tab?.id != null) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1a8a4a', tabId: tab.id });
    await chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 1500);
  }
});

/* ---------- liczniki powiadomień ---------- */

async function getBadges() {
  return (await chrome.storage.local.get('badges')).badges || {};
}

// zapisy liczników kolejkowane, żeby się nie nadpisywały
let badgeQueue = Promise.resolve();
function updateBadges(fn) {
  badgeQueue = badgeQueue.then(async () => {
    const b = await getBadges();
    if (fn(b) !== false) await chrome.storage.local.set({ badges: b });
  }).catch(e => console.warn(e));
  return badgeQueue;
}

async function checkGmail() {
  const data = await loadLocal();
  if (!data?.settings.badges) return;
  if (!allTiles(data).some(({ tile }) => hostOf(tile.url) === 'mail.google.com')) return;
  try {
    const r = await fetch('https://mail.google.com/mail/feed/atom', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const m = (await r.text()).match(/<fullcount>(\d+)<\/fullcount>/);
    const n = m ? +m[1] : 0;
    await updateBadges(b => {
      if (n > 0) b['mail.google.com'] = { n, src: 'gmail', at: Date.now() };
      else delete b['mail.google.com'];
    });
  } catch {
    await updateBadges(b => {
      if (b['mail.google.com']?.src !== 'gmail') return false;
      delete b['mail.google.com'];
    });
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'gmail') checkGmail(); });

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'refreshBadges') { Promise.all([checkGmail(), validateTitleBadges()]).finally(() => reply(true)); return true; }
});

// liczniki z tytułów kart, np. "(3) Facebook", "Odebrane (12) - Gmail"
const COUNT_RE = /\((\d{1,4})\+?\)/;

// usuwa liczniki, których karta już nie istnieje, przeszła na inną stronę albo nie ma liczby w tytule
// (np. po zamknięciu całej przeglądarki Chrome nie zgłasza zamknięcia kart)
async function validateTitleBadges() {
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  await updateBadges(b => {
    let changed = false;
    for (const host in b) {
      const x = b[host];
      if (x.src !== 'title') continue;
      const t = byId.get(x.tabId);
      const m = t && t.url && hostOf(t.url) === host && (t.title || '').match(COUNT_RE);
      if (!m) { delete b[host]; changed = true; }
      else if (+m[1] !== x.n) { x.n = +m[1]; changed = true; }
    }
    return changed;
  });
}
chrome.runtime.onStartup.addListener(() => validateTitleBadges());
validateTitleBadges();

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if ((change.title !== undefined || change.url !== undefined) && tab.url) onTitle(tabId, tab);
  if (change.status === 'complete' && tab.active) setTimeout(() => maybeCapture(tab.id), 1200);
});

chrome.tabs.onRemoved.addListener(tabId => {
  updateBadges(b => {
    let changed = false;
    for (const k in b) if (b[k].src === 'title' && b[k].tabId === tabId) { delete b[k]; changed = true; }
    return changed;
  });
});

async function onTitle(tabId, tab) {
  const data = await loadLocal();
  if (!data?.settings.badges) return;
  if (!matchTile(data, tab.url)) return;
  const host = hostOf(tab.url);
  const m = (tab.title || '').match(COUNT_RE);
  updateBadges(b => {
    // ta karta przeszła z innej strony – licznik tamtej strony znika
    let moved = false;
    for (const k in b) if (k !== host && b[k].src === 'title' && b[k].tabId === tabId) { delete b[k]; moved = true; }
    const cur = b[host];
    if (cur?.src === 'gmail') return moved; // Gmail liczony z kanału
    if (m) {
      if (cur?.n === +m[1] && cur.tabId === tabId) return moved;
      b[host] = { n: +m[1], src: 'title', tabId, at: Date.now() };
    } else {
      if (!cur || cur.tabId !== tabId) return moved;
      delete b[host];
    }
  });
}

/* ---------- podglądy stron ---------- */

const THUMB_MAX_AGE = 2 * 60 * 60 * 1000; // 2 h
let lastCapture = 0;

chrome.tabs.onActivated.addListener(({ tabId }) => setTimeout(() => maybeCapture(tabId), 800));

async function maybeCapture(tabId) {
  try {
    const data = await loadLocal();
    if (!data) return;
    if (capturing) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.status !== 'complete' || !/^https?:/.test(tab.url || '')) return;
    const tile = matchTile(data, tab.url);
    if (!tile) return;
    // auto-odświeżanie: gdy podglądy włączone globalnie albo dla tego kafelka
    if (tile.preview === false || (!data.settings.thumbnails && tile.preview !== true)) return;
    const key = 'thumb_' + tile.id;
    const old = (await chrome.storage.local.get(key))[key];
    if (old && Date.now() - old.at < THUMB_MAX_AGE) return;
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused || win.state === 'minimized') return;
    if (Date.now() - lastCapture < 1000) return; // limit Chrome: 2 zrzuty / s
    lastCapture = Date.now();

    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    const img = await shrink(shot, 480, 300);
    await chrome.storage.local.set({ [key]: { img, at: Date.now(), url: tab.url } });
  } catch (e) {
    // brak uprawnień / karta zamknięta / strona chroniona – pomijamy
  }
}

async function shrink(dataUrl, W, H) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = W / bmp.width;
  const srcH = Math.min(bmp.height, H / scale);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, bmp.width, srcH, 0, 0, W, srcH * scale);
  const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}

/* ---------- ikony wysokiej jakości ---------- */

const ICON_MAX_AGE = 30 * 24 * 3600e3;   // odśwież co 30 dni
const ICON_RETRY = 24 * 3600e3;          // po nieudanej próbie – za dobę
const iconPending = [];
const iconKnown = new Set();
let iconActive = 0;

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'resolveIcons') {
    (msg.urls || []).forEach(u => queueIcon(u, !!msg.force));
    reply(true);
  }
});

function iconHost(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

function queueIcon(url, force) {
  const host = iconHost(url);
  if (!host || iconKnown.has(host)) return;
  iconKnown.add(host);
  iconPending.push({ url, host, force });
  pumpIcons();
}

let keepAliveTimer = null;
function keepAlive(on) {
  if (on && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  if (!on && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function pumpIcons() {
  keepAlive(iconActive > 0 || iconPending.length > 0 || capturing);
  while (iconActive < 3 && iconPending.length) {
    const job = iconPending.shift();
    iconActive++;
    resolveIcon(job).catch(e => console.warn('icon', job.host, e))
      .finally(() => { iconActive--; iconKnown.delete(job.host); pumpIcons(); });
  }
  if (!iconActive && !iconPending.length && !capturing) keepAlive(false);
}

async function fetchT(url, ms = 6000, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&') : null;
};
const maxSize = s => {
  if (!s) return 0;
  if (/any/i.test(s)) return 512;
  return Math.max(0, ...[...s.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map(m => Math.min(+m[1], +m[2])));
};

async function findCandidates(url) {
  const out = [];
  const origin = new URL(url).origin;
  let canPage = false;
  try { canPage = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch {}

  if (canPage) {
    let manifestUrl = null;
    try {
      const r = await fetchT(url, 7000, { credentials: 'omit' });
      const base = r.url || url;
      const html = (await r.text()).slice(0, 500000);
      const head = html.split(/<\/head>/i)[0];
      for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        const rel = (attr(tag, 'rel') || '').toLowerCase();
        const href = attr(tag, 'href');
        if (!href) continue;
        let abs;
        try { abs = new URL(href, base).href; } catch { continue; }
        if (rel.split(/\s+/).includes('manifest')) { manifestUrl = abs; continue; }
        if (!/\bicon\b|apple-touch-icon/.test(rel) || rel.includes('mask-icon')) continue;
        const type = attr(tag, 'type') || '';
        const svg = /svg/.test(type) || /\.svg(\?|#|$)/i.test(abs);
        const size = svg ? 512 : (maxSize(attr(tag, 'sizes')) || (rel.includes('apple') ? 180 : 32));
        out.push({ src: abs, size, svg });
      }
    } catch {}
    if (manifestUrl) {
      try {
        const j = await (await fetchT(manifestUrl, 5000, { credentials: 'omit' })).json();
        for (const ic of j.icons || []) {
          const purpose = ic.purpose || 'any';
          if (/monochrome/.test(purpose) && !/any/.test(purpose)) continue;
          out.push({
            src: new URL(ic.src, manifestUrl).href,
            size: maxSize(ic.sizes) || 192,
            svg: /svg/.test(ic.type || '') || /\.svg(\?|$)/i.test(ic.src),
            maskable: /maskable/.test(purpose) && !/any/.test(purpose)
          });
        }
      } catch {}
    }
    out.push({ src: origin + '/apple-touch-icon.png', size: 180 });
  }
  out.push({ src: `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=256`, size: 100 });
  if (canPage) out.push({ src: origin + '/favicon.ico', size: 32 });

  const seen = new Set();
  return out.filter(c => !seen.has(c.src) && seen.add(c.src))
    .sort((a, b) => (b.svg - a.svg) || ((b.size - (b.maskable ? 200 : 0)) - (a.size - (a.maskable ? 200 : 0))));
}

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function loadCandidate(c) {
  const r = await fetchT(c.src, 6000, { credentials: 'omit' });
  if (!r.ok) return null;
  const blob = await r.blob();
  const ct = (r.headers.get('content-type') || blob.type || '').toLowerCase();
  if (blob.size < 60 || blob.size > 2_000_000) return null;
  if (/text\/html/.test(ct)) return null;

  if (/svg/.test(ct) || (c.svg && !/^image\/(png|jpe?g|gif|webp|x-icon|vnd)/.test(ct))) {
    const text = await blob.text();
    if (!/<svg[\s>]/i.test(text) || text.length > 300000) return null;
    return { svg: true, w: 512, opaque: false, src: c.src,
      img: 'data:image/svg+xml;base64,' + toB64(new TextEncoder().encode(text)) };
  }

  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return null; }
  const w = Math.min(bmp.width, bmp.height);
  if (w < 10) return null;
  const S = Math.min(256, Math.max(bmp.width, bmp.height));
  const cv = new OffscreenCanvas(S, S);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const k = S / Math.max(bmp.width, bmp.height);
  const dw = bmp.width * k, dh = bmp.height * k;
  ctx.drawImage(bmp, (S - dw) / 2, (S - dh) / 2, dw, dh);
  // czy ikona ma nieprzezroczyste rogi (kwadratowe tło)?
  const px = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
  const e = Math.max(1, Math.round(S * 0.02));
  const opaque = [px(e, e), px(S - 1 - e, e), px(e, S - 1 - e), px(S - 1 - e, S - 1 - e)].every(a => a > 245);
  const out = await cv.convertToBlob({ type: 'image/png' });
  return { svg: false, w, opaque, src: c.src,
    img: 'data:image/png;base64,' + toB64(new Uint8Array(await out.arrayBuffer())) };
}

async function resolveIcon({ url, host, force }) {
  const key = 'icon_' + host;
  let canPage = false;
  try { canPage = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch {}
  if (!force) {
    const old = (await chrome.storage.local.get(key))[key];
    if (old) {
      const age = Date.now() - old.at;
      if (old.img && age < ICON_MAX_AGE && (old.viaPage || !canPage)) return;
      if (old.fail && age < ICON_RETRY) return;
    }
  }
  const cands = await findCandidates(url);
  let best = null;
  for (const c of cands.slice(0, 7)) {
    const r = await loadCandidate(c).catch(() => null);
    if (!r) continue;
    r.score = (r.svg ? 400 : Math.min(r.w, 256)) + (r.opaque ? 0 : 40) - (c.maskable ? 80 : 0);
    if (!best || r.score > best.score) best = r;
    if (best.svg || (best.w >= 128 && !best.opaque)) break; // wystarczająco dobra
  }
  if (!best) {
    await chrome.storage.local.set({ [key]: { fail: true, at: Date.now() } });
    return;
  }
  await chrome.storage.local.set({ [key]: {
    img: best.img, w: best.w, svg: best.svg, opaque: best.opaque, src: best.src, at: Date.now(), viaPage: canPage
  } });
}

/* ---------- podglądy wszystkich stron na żądanie ---------- */

let capturing = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'captureAll') { captureTiles(msg.ids || null); reply(true); }
  if (msg?.type === 'captureCancel') { capturing = false; reply(true); }
});

async function waitComplete(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(300);
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete' && t.url && t.url !== 'about:blank') return true;
    } catch { return false; }
  }
  return false;
}

async function captureTiles(ids) {
  if (capturing) return;
  const data = await loadLocal();
  if (!data) return;
  let tiles = allTiles(data).map(x => x.tile).filter(t => /^https?:/.test(t.url));
  if (ids) tiles = tiles.filter(t => ids.includes(t.id));
  if (!tiles.length) return;

  capturing = true;
  keepAlive(true);
  let win;
  try {
    win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', width: 1280, height: 860 });
    const tabId = win.tabs[0].id;
    let done = 0;
    for (const t of tiles) {
      if (!capturing) break;
      await chrome.storage.local.set({ captureProgress: { done, total: tiles.length, title: t.title } });
      try {
        await chrome.tabs.update(tabId, { url: t.url, muted: true });
        await waitComplete(tabId, 20000);
        await sleep(1800); // czas na dorysowanie strony
        const shot = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 75 });
        const img = await shrink(shot, 480, 300);
        await chrome.storage.local.set({ ['thumb_' + t.id]: { img, at: Date.now(), url: t.url } });
      } catch (e) { console.warn('podgląd', t.url, e?.message); }
      done++;
    }
  } finally {
    capturing = false;
    if (win) chrome.windows.remove(win.id).catch(() => {});
    await chrome.storage.local.set({ captureProgress: null });
    keepAlive(false);
  }
}

/* ---------- własne obrazy kafelków: z adresu i ze strony ---------- */

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'fetchImage') {
    fetchImageData(msg.url, msg.max || 640).then(data => reply({ ok: true, data }))
      .catch(e => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'findImages') {
    findSiteImages(msg.url).then(list => reply({ ok: true, list }))
      .catch(e => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

async function fetchImageData(url, max = 640) {
  if (url.startsWith('data:')) return url;
  const r = await fetchT(url, 12000, { credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  const ct = (r.headers.get('content-type') || blob.type || '').toLowerCase();
  if (/text\/html/.test(ct)) throw new Error('to nie jest obraz');
  if (/svg/.test(ct)) {
    const t = await blob.text();
    if (!/<svg[\s>]/i.test(t)) throw new Error('to nie jest obraz');
    return 'data:image/svg+xml;base64,' + toB64(new TextEncoder().encode(t));
  }
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const jpeg = /jpe?g/.test(ct);
  const out = await cv.convertToBlob(jpeg ? { type: 'image/jpeg', quality: 0.88 } : { type: 'image/png' });
  return `data:${out.type};base64,` + toB64(new Uint8Array(await out.arrayBuffer()));
}

// Galeria logo użytkowników FVD Speed Dial (to samo źródło co „Custom Preview” w starym dodatku)
async function fvdGallery(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return []; }
  const bare = host.replace(/^www\./, '');
  const hosts = [...new Set([host, bare, 'www.' + bare])];
  const lists = await Promise.all(hosts.map(async h => {
    try {
      const r = await fetchT(`https://everhelper.pro/sdpreviews/listing.php?p=0&order=rating&on_page=12&host=${encodeURIComponent(h)}`, 8000, { credentials: 'omit' });
      const j = await r.json();
      return (j?.body?.previews || []).map(p => p.url).filter(Boolean);
    } catch { return []; }
  }));
  return [...new Set(lists.flat())];
}

async function findSiteImages(url) {
  const galleryP = fvdGallery(url); // równolegle ze skanowaniem strony
  const out = [];
  const add = (src, kind, base, prio) => {
    if (!src) return;
    if (src.startsWith('data:')) { if (src.length < 300000) out.push({ src, kind, prio }); return; }
    try { out.push({ src: new URL(src.replace(/&amp;/g, '&'), base).href, kind, prio }); } catch {}
  };
  const origin = new URL(url).origin;
  try {
    const r = await fetchT(url, 7000, { credentials: 'omit' });
    const base = r.url || url;
    const html = (await r.text()).slice(0, 800000);

    // 1. logo z danych strukturalnych (schema.org / JSON-LD)
    for (const m of html.matchAll(/"logo"\s*:\s*"([^"]+)"/gi)) add(m[1].replace(/\\\//g, '/'), 'Logo (dane strony)', base, 1);
    for (const m of html.matchAll(/"logo"\s*:\s*\{[^}]*?"(?:url|contentUrl)"\s*:\s*"([^"]+)"/gi)) add(m[1].replace(/\\\//g, '/'), 'Logo (dane strony)', base, 1);

    // 2. logo w SVG wstawione w kod strony
    let svgs = 0;
    for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
      const open = m[0].slice(0, 400);
      if (!/logo|brand/i.test(open) && !/logo|brand/i.test(html.slice(Math.max(0, m.index - 250), m.index))) continue;
      if (m[0].length < 200 || m[0].length > 200000) continue;
      let svg = m[0];
      if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      add('data:image/svg+xml;base64,' + toB64(new TextEncoder().encode(svg)), 'Logo SVG ze strony', base, 2);
      if (++svgs >= 3) break;
    }

    // 3. obrazki z "logo" w nazwie, klasie, alt – lub wewnątrz elementu z klasą logo
    let logos = 0;
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const before = html.slice(Math.max(0, m.index - 300), m.index);
      if (!/logo|brand/i.test(m[0]) && !/class\s*=\s*["'][^"']*(logo|brand)[^"']*["'][^<]*$/i.test(before)) continue;
      const srcset = attr(m[0], 'srcset');
      const best = srcset ? srcset.split(',').map(x => x.trim().split(/\s+/)[0]).pop() : null;
      add(best || attr(m[0], 'src') || attr(m[0], 'data-src') || attr(m[0], 'data-lazy-src'), 'Logo ze strony', base, 3);
      if (++logos >= 8) break;
    }

    // 4. obraz podglądu strony
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const p = (attr(m[0], 'property') || attr(m[0], 'name') || attr(m[0], 'itemprop') || '').toLowerCase();
      if (/^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src|image)$/.test(p)) add(attr(m[0], 'content'), 'Obraz podglądu', base, 4);
    }
    // 5. ikony
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const rel = (attr(m[0], 'rel') || '').toLowerCase();
      if (rel === 'image_src') add(attr(m[0], 'href'), 'Obraz podglądu', base, 4);
      else if (/apple-touch-icon|\bicon\b/.test(rel) && !rel.includes('mask')) add(attr(m[0], 'href'), 'Ikona', base, 5);
    }
  } catch {}
  add('/apple-touch-icon.png', 'Ikona', origin, 5);
  add(`https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=256`, 'Ikona (Google)', origin, 6);
  (await galleryP).forEach(src => out.push({ src, kind: 'Galeria FVD', prio: 0 }));
  const seen = new Set();
  return out.filter(x => !seen.has(x.src) && seen.add(x.src))
    .sort((a, b) => a.prio - b.prio).slice(0, 24);
}


/* ---------- monitor stron, obserwowanie zmian, automatyczna kopia ---------- */

async function setupAlarms() {
  const data = await loadLocal();
  const every = Math.max(15, data?.settings.monitorEvery || 60);
  const a = await chrome.alarms.get('monitor');
  if (!a || a.periodInMinutes !== every) chrome.alarms.create('monitor', { periodInMinutes: every, delayInMinutes: 1 });
  if (!(await chrome.alarms.get('backup'))) chrome.alarms.create('backup', { periodInMinutes: 360, delayInMinutes: 2 });
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'monitor') runMonitor(false);
  if (a.name === 'backup') maybeBackup(false).catch(e => chrome.storage.local.set({ backupError: String(e?.message || e) }));
});

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'monitorNow') { runMonitor(true).then(r => reply(r)).catch(e => reply({ error: String(e) })); return true; }
  if (msg?.type === 'monitorConfig') { setupAlarms().then(() => reply(true)); return true; }
  if (msg?.type === 'backupNow') { maybeBackup(true).then(r => reply(r)).catch(e => reply({ ok: false, error: String(e?.message || e || 'nieznany błąd') })); return true; }
});

chrome.notifications?.onClicked.addListener(id => {
  if (id.startsWith('watch:')) chrome.tabs.create({});
});

// teksty linków ze strony – „odcisk” treści do wykrywania nowości
function linkTexts(html) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
    if (t.length >= 6 && t.length <= 140 && !/^\d+$/.test(t)) out.add(t);
    if (out.size >= 600) break;
  }
  return [...out];
}

let monitorRunning = false;
async function runMonitor(manual) {
  if (monitorRunning) return { busy: true };
  const data = await loadLocal();
  if (!data) return {};
  const s = data.settings;
  const tiles = allTiles(data).map(x => x.tile).filter(t => /^https?:/.test(t.url));
  const watched = tiles.filter(t => t.watch);
  const list = (s.monitorOn || manual) ? tiles : watched;
  if (!list.length) return { checked: 0 };
  monitorRunning = true;
  keepAlive(true);
  const st = await chrome.storage.local.get(['health', 'changes']);
  const health = st.health || {};
  const changes = st.changes || {};
  const notes = [];
  let i = 0, down = 0;
  const worker = async () => {
    while (i < list.length) {
      const t = list[i++];
      let ok = false, status = 0, html = '';
      try {
        const r = await fetchT(t.url, 15000, { credentials: 'include', cache: 'no-store' });
        status = r.status;
        ok = status > 0 && status < 500 && status !== 404 && status !== 410;
        if (t.watch && r.ok) html = (await r.text()).slice(0, 1500000);
      } catch { ok = false; }
      if (s.monitorOn || manual) {
        health[t.id] = { ok, status, at: Date.now() };
        if (!ok) down++;
      }
      if (t.watch && html) {
        const key = 'watch_' + t.id;
        const prev = (await chrome.storage.local.get(key))[key];
        const now = linkTexts(html);
        if (prev && prev.length) {
          const old = new Set(prev);
          const fresh = now.filter(x => !old.has(x));
          // ignoruj drobne zmiany (np. zegar, licznik online)
          if (fresh.length >= 1 && fresh.length < now.length * 0.8) {
            const c = changes[t.id] || { n: 0, items: [] };
            c.n = Math.min(99, c.n + fresh.length);
            c.items = [...fresh, ...c.items].slice(0, 8);
            c.at = Date.now();
            changes[t.id] = c;
            notes.push({ t, fresh });
          }
        }
        await chrome.storage.local.set({ [key]: now });
      }
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const id in health) if (!tiles.some(t => t.id === id)) delete health[id];
    await chrome.storage.local.set({ health, changes, monitorLast: Date.now() });
    if (s.watchNotify && notes.length && chrome.notifications) {
      for (const { t, fresh } of notes.slice(0, 3)) {
        chrome.notifications.create('watch:' + t.id + ':' + Date.now(), {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: `Nowości: ${t.title}`,
          message: fresh.slice(0, 3).join(' · ').slice(0, 200),
          priority: 0
        });
      }
    }
  } finally {
    monitorRunning = false;
    keepAlive(false);
  }
  return { checked: list.length, down, changed: notes.length };
}

/* automatyczna kopia zapasowa do folderu Pobrane/MojaKarta-kopie */
async function maybeBackup(force) {
  const data = await loadLocal();
  if (!data) return { ok: false };
  const mode = data.settings.backupMode || 'weekly';
  const st = await chrome.storage.local.get(['backupLast', 'backupIds', 'bgImage']);
  const every = mode === 'daily' ? 864e5 : 7 * 864e5;
  if (!force && (mode === 'off' || (st.backupLast && Date.now() - st.backupLast < every))) return { skipped: true };
  const day = new Date().toLocaleDateString('sv-SE');
  const payload = { app: 'moja-karta', version: 2, exported: new Date().toISOString(), data, bgImage: st.bgImage || null, extras: await collectExtras() };
  const json = JSON.stringify(payload);
  const url = 'data:application/json;base64,' + toB64(new TextEncoder().encode(json));
  const id = await chrome.downloads.download({
    url, filename: `MojaKarta-kopie/moja-karta-${day}.json`, conflictAction: 'overwrite', saveAs: false
  });
  // zostaw 8 najnowszych kopii
  const ids = [id, ...(st.backupIds || []).filter(x => x !== id)];
  for (const old of ids.slice(8)) {
    try { await chrome.downloads.removeFile(old); } catch {}
    try { await chrome.downloads.erase({ id: old }); } catch {}
  }
  await chrome.storage.local.set({ backupLast: Date.now(), backupIds: ids.slice(0, 8), backupError: null });
  return { ok: true, id, size: json.length };
}

setupAlarms();


/* ---------- Opera: nie pozwala zastąpić nowej karty – otwórz Moją Kartę przy starcie ---------- */
const IS_OPERA = /\bOPR\//.test(navigator.userAgent);
async function openOnStartup() {
  const data = await loadLocal();
  const flag = data?.settings.openOnStartup;
  if (flag === false || (flag == null && !IS_OPERA)) return;
  const url = chrome.runtime.getURL('newtab.html');
  const tabs = await chrome.tabs.query({});
  if (tabs.some(t => t.url === url)) return;
  chrome.tabs.create({ url, active: true });
}
chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install' && IS_OPERA) chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
});
