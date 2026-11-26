import { findSiteImages, fetchImageData } from './images.js';
import { discoverFeed, loadFeed } from './rss.js';
import { setFx } from './fx.js';
import {
  uid, loadData, saveData, saveLocalOnly, normalizeData, defaultData, normalizeUrl, hostOf,
  titleFromUrl, addTile, makeTile, makeFolder, isFolder, findItem, allTiles,
  pullSync, mergeRemote, hashPin, isAddableUrl, urlKey, collectExtras, restoreExtras, GRADIENTS, ENGINES
} from './storage.js';

const $ = s => document.querySelector(s);
const IS_FIREFOX = /\bFirefox\//.test(navigator.userAgent);
const EXT_PAGE = IS_FIREFOX ? 'about:addons' : /\bOPR\//.test(navigator.userAgent) ? 'opera://extensions' : /\bEdg\//.test(navigator.userAgent) ? 'edge://extensions' : 'chrome://extensions';
const TILE_W = { s: 115, m: 150, l: 200 };
const TILE_W_CLASSIC = { s: 160, m: 192, l: 236 };
const TITLE_FONTS = {
  system: 'inherit',
  rounded: '"Nunito", "Segoe UI Rounded", "Arial Rounded MT Bold", system-ui, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: '"Trebuchet MS", "Segoe UI", sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace'
};
const UNLOCK_MS = 15 * 60 * 1000;
const AUTHOR = 'adi82bdg';
const EMOJIS = ['🛒','📧','🎬','🎵','📰','💼','🏦','📚','🎮','🍕','✈️','🏠','⚽','💬','📷','🗺️','☁️','🔧','📊','❤️','⭐','🔥','🧾','🎓','🛠️','🚗','🌐','📺'];

let data;
let bgImage = null;
let badges = {};
const thumbs = new Map();
const icons = new Map();   // host -> { img, w, svg, opaque }
let health = {};           // id kafelka -> { ok, status, at }
let changes = {};          // id kafelka -> { n, items, at }
let unlockedUntil = 0;

let dragId = null;
let dragHandled = false;
let mergeTargetId = null;
let pendingRender = false;
let openFolderId = null;
let viewRecent = false;   // zakładka „Ostatnio zamknięte”
const selected = new Set(); // zaznaczone kafelki (Ctrl+klik)
let groupDragId = null;     // przeciągana zakładka grupy
let hoverTimer = null;      // przełączanie grupy po przytrzymaniu kafelka
const RO = () => !!S().readOnly;

/* ================= start ================= */

init();

async function init() {
  data = await loadData();
  const loc = await chrome.storage.local.get(['bgImage', 'badges', 'health', 'changes']);
  health = loc.health || {};
  changes = loc.changes || {};
  bgImage = loc.bgImage || null;
  await loadBgExtras();
  badges = loc.badges || {};
  await loadThumbs();
  await loadIcons();
  try { unlockedUntil = (await chrome.storage.session.get('unlockedUntil')).unlockedUntil || 0; } catch {}

  applySettings();
  render();
  bindStatic();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(checkLockExpiry, 15000);
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
  chrome.runtime.sendMessage({ type: 'refreshBadges' }).catch(() => {});
  downloadImportedImages();
  checkNeedsReload();
  setTimeout(() => refreshNews(false), 1500);
  loadRates();
  renderCountdowns();
  setInterval(renderCountdowns, 10 * 60 * 1000);

  chrome.storage.onChanged.addListener(onStorageChanged);
}

/* ================= wiadomości (RSS) ================= */

const NEWS_TTL = 20 * 60 * 1000;
let newsItems = [];
let newsLoading = false;

async function refreshNews(force) {
  const feeds = S().rssFeeds || [];
  updateNewsButton();
  if (!S().rssOn || !feeds.length) { newsItems = []; renderNews(); return; }
  const { rssCache = {} } = await chrome.storage.local.get('rssCache');
  const stale = feeds.filter(f => force || !rssCache[f.url] || Date.now() - rssCache[f.url].at > NEWS_TTL);
  collectNews(rssCache);
  if (!stale.length) return;
  newsLoading = true;
  renderNews();
  await Promise.all(stale.map(async f => {
    try {
      const r = await loadFeed(f.url);
      rssCache[f.url] = { at: Date.now(), items: r.items.slice(0, 60), error: null };
    } catch (e) {
      rssCache[f.url] = { ...(rssCache[f.url] || { items: [] }), at: Date.now(), error: String(e?.message || e) };
    }
  }));
  for (const k in rssCache) if (!feeds.some(f => f.url === k)) delete rssCache[k];
  await chrome.storage.local.set({ rssCache });
  newsLoading = false;
  collectNews(rssCache);
}

function collectNews(cache) {
  const feeds = S().rssFeeds || [];
  const all = [];
  for (const f of feeds) for (const it of cache[f.url]?.items || []) all.push({ ...it, source: f.title || hostOf(f.url), feed: f.url });
  all.sort((a, b) => b.date - a.date);
  newsItems = all.slice(0, S().rssMax || 50);
  renderNews(cache);
  updateNewsButton();
}

function updateNewsButton() {
  const btn = $('#btn-news');
  const on = S().rssOn && (S().rssFeeds || []).length > 0;
  btn.hidden = !on;
  const unread = newsItems.filter(i => i.date > (S().rssSeen || 0)).length;
  const b = $('#news-count');
  b.hidden = !unread || !$('#news-panel').hidden;
  b.textContent = unread > 99 ? '99+' : unread;
}

function renderNews(cache) {
  const list = $('#news-list');
  if (!list) return;
  list.innerHTML = '';
  const seen = S().rssSeen || 0;
  if (newsLoading && !newsItems.length) { list.innerHTML = '<div class="news-empty">Wczytuję wiadomości…</div>'; return; }
  if (!newsItems.length) {
    list.innerHTML = '<div class="news-empty">Brak wiadomości.<br>Dodaj kanały w Ustawienia → 📰 Wiadomości.</div>';
  }
  for (const it of newsItems) {
    const a = document.createElement('a');
    a.className = 'news-item' + (it.date > seen ? ' unread' : '');
    a.href = it.link;
    if (S().openInNewTab) { a.target = '_blank'; a.rel = 'noopener'; }
    const t = document.createElement('div');
    t.className = 'news-title';
    t.textContent = it.title;
    const m = document.createElement('div');
    m.className = 'news-meta';
    const fav = favImg(it.feed);
    fav.className = 'news-fav';
    m.append(fav, document.createTextNode(`${it.source}${it.date ? ' · ' + timeAgo(it.date) : ''}`));
    a.append(t, m);
    list.append(a);
  }
  const errs = cache ? (S().rssFeeds || []).filter(f => cache[f.url]?.error) : [];
  if (errs.length) {
    const e = document.createElement('div');
    e.className = 'news-err';
    e.textContent = '⚠ Nie udało się wczytać: ' + errs.map(f => f.title || hostOf(f.url)).join(', ');
    list.append(e);
  }
}

function toggleNews(show) {
  const p = $('#news-panel');
  const open = show ?? p.hidden;
  if (open && !$('#pad-panel').hidden) togglePad(false);
  p.hidden = !open;
  document.body.classList.toggle('news-open', open);
  if (open) {
    refreshNews(false);
  } else if (newsItems.length) {
    // zamknięcie panelu = wiadomości przeczytane
    S().rssSeen = Math.max(...newsItems.map(i => i.date), S().rssSeen || 0);
    save();
    renderNews();
  }
  updateNewsButton();
}

function renderFeedList() {
  const box = $('#rss-list');
  box.innerHTML = '';
  const feeds = S().rssFeeds || [];
  if (!feeds.length) box.innerHTML = '<div class="set-row"><div class="set-desc">Nie dodano jeszcze żadnych kanałów.</div></div>';
  feeds.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    const txt = document.createElement('div');
    txt.className = 'set-text';
    txt.innerHTML = '<div class="set-name"></div><div class="set-desc"></div>';
    txt.querySelector('.set-name').textContent = f.title || hostOf(f.url);
    txt.querySelector('.set-desc').textContent = f.url;
    const ctl = document.createElement('div');
    ctl.className = 'set-ctl';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'btn ghost small-btn'; x.textContent = '✕'; x.title = 'Usuń kanał';
    x.onclick = () => { S().rssFeeds.splice(i, 1); save(); renderFeedList(); refreshNews(false); };
    ctl.append(x);
    row.append(txt, ctl);
    box.append(row);
  });
}

async function addFeed(input) {
  const info = $('#rss-info');
  if (!input.trim()) return;
  info.textContent = 'Szukam kanału…';
  try {
    const f = await discoverFeed(input);
    S().rssFeeds ||= [];
    if (S().rssFeeds.some(x => x.url === f.url)) { info.textContent = 'Ten kanał już jest na liście.'; return; }
    S().rssFeeds.push({ url: f.url, title: f.title });
    await save();
    info.textContent = '✓ Dodano: ' + f.title;
    $('#rss-url').value = '';
    renderFeedList();
    refreshNews(true);
  } catch (e) {
    info.textContent = '⚠ ' + (e.message || e);
  }
}

// odmiana: 1 kanał, 2 kanały, 5 kanałów
function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

// wykryj kanały RSS na stronach z kafelków
async function detectFeedsFromTiles() {
  const info = $('#rss-info');
  const hosts = new Map();
  for (const { tile } of allTiles(data)) if (/^https?:/.test(tile.url)) { try { const o = new URL(tile.url).origin; if (!hosts.has(o)) hosts.set(o, tile); } catch {} }
  const list = [...hosts.values()];
  let found = 0, i = 0, done = 0;
  info.textContent = `Sprawdzam ${list.length} stron…`;
  const worker = async () => {
    while (i < list.length) {
      const t = list[i++];
      try {
        const f = await discoverFeed(t.url);
        S().rssFeeds ||= [];
        if (!S().rssFeeds.some(x => x.url === f.url)) { S().rssFeeds.push({ url: f.url, title: f.title || t.title }); found++; renderFeedList(); }
      } catch {}
      info.textContent = `Sprawdzono ${++done} z ${list.length} stron · znaleziono ${found} ${plural(found, 'kanał', 'kanały', 'kanałów')}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await save();
  info.textContent = found ? `✓ Dodano ${found} ${plural(found, 'kanał', 'kanały', 'kanałów')}. Niepotrzebne usuń krzyżykiem.` : 'Nie znaleziono nowych kanałów.';
  refreshNews(true);
}

// pliki dodatku podmienione, ale Chrome nie przeładował dodatku (nowe uprawnienia nie działają)
async function checkNeedsReload() {
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    const loaded = chrome.runtime.getManifest();
    const missing = (disk.permissions || []).filter(p => !(loaded.permissions || []).includes(p));
    if (disk.version === loaded.version && !missing.length) return;
    const bar = document.createElement('div');
    bar.className = 'reload-bar';
    bar.innerHTML = `<span>🔄 Zainstalowano nową wersję <b></b>, ale Chrome używa jeszcze starej (<i></i>). Przeładuj dodatek, żeby wszystko działało.</span>
      <button type="button" class="btn primary small-btn">Przeładuj teraz</button>`;
    bar.querySelector('b').textContent = disk.version;
    bar.querySelector('i').textContent = loaded.version;
    bar.querySelector('button').onclick = () => chrome.runtime.reload();
    document.body.append(bar);
  } catch {}
}

// kafelki z adresem obrazu (np. z importu FVD) – pobierz i zapisz obraz lokalnie
let downloadingImages = false;
async function downloadImportedImages() {
  if (downloadingImages) return;
  const todo = allTiles(data).map(x => x.tile).filter(t => t.imageSrc && !t.image && !t.imageSrcFail);
  if (!todo.length) return;
  downloadingImages = true;
  for (const t of todo) {
    let r = null;
    try { r = { ok: true, data: await fetchImageData(t.imageSrc, 640) }; } catch {}
    const it = findItem(data, t.id).item;
    if (!it) continue;
    if (r?.ok) { it.image = r.data; it.imageFit ||= 'contain'; }
    else it.imageSrcFail = true;
    await save();
    safeRender();
  }
  downloadingImages = false;
}

async function loadBgExtras() {
  const keys = ['bgRotate', ...data.groups.map(g => 'gbg_' + g.id)];
  const r = await chrome.storage.local.get(keys);
  rotateImages = r.bgRotate || [];
  groupBgImages.clear();
  for (const g of data.groups) if (r['gbg_' + g.id]) groupBgImages.set(g.id, r['gbg_' + g.id]);
}

async function loadIcons() {
  const hosts = [...new Set(allTiles(data).map(({ tile }) => 'icon_' + hostOf(tile.url)))];
  if (!hosts.length) return;
  const r = await chrome.storage.local.get(hosts);
  for (const k in r) icons.set(k.slice(5), r[k]);
}

async function loadThumbs() {
  const keys = allTiles(data).map(({ tile }) => 'thumb_' + tile.id);
  if (!keys.length) return;
  const r = await chrome.storage.local.get(keys);
  for (const k in r) if (r[k]?.img) thumbs.set(k.slice(6), r[k].img);
}

let thumbTimer;
async function onStorageChanged(ch, area) {
  if (area === 'local') {
    if (ch.bgImage) { bgImage = ch.bgImage.newValue || null; applyBackground(); }
    if (ch.badges) { badges = ch.badges.newValue || {}; safeRender(); }
    if (ch.health) { health = ch.health.newValue || {}; safeRender(); }
    if (ch.changes) { changes = ch.changes.newValue || {}; safeRender(); }
    if (ch.backupLast && !$('#settings-modal').hidden) showBackupInfo();
    if (ch.syncStatus && !$('#settings-modal').hidden) showSyncInfo();
    if ('captureProgress' in ch) showCaptureProgress(ch.captureProgress.newValue);
    let thumbChanged = false;
    for (const k in ch) if (k.startsWith('thumb_')) {
      const v = ch[k].newValue;
      if (v?.img) thumbs.set(k.slice(6), v.img); else thumbs.delete(k.slice(6));
      thumbChanged = true;
    }
    if (thumbChanged) { clearTimeout(thumbTimer); thumbTimer = setTimeout(safeRender, 300); }
    let iconChanged = false;
    for (const k in ch) if (k.startsWith('icon_')) {
      const v = ch[k].newValue;
      if (v) icons.set(k.slice(5), v); else icons.delete(k.slice(5));
      iconChanged = true;
    }
    if (iconChanged) { clearTimeout(thumbTimer); thumbTimer = setTimeout(safeRender, 250); }
    if (ch.data) {
      if (JSON.stringify(ch.data.newValue) === JSON.stringify(data)) return;
      const nd = normalizeData(ch.data.newValue);
      if (nd) { data = nd; applySettings(); await loadThumbs(); await loadIcons(); safeRender(); renderPad(true); renderCountdowns(); }
    }
  } else if (area === 'sync') {
    if (!S().sync || !ch.sd_meta?.newValue) return;
    if (ch.sd_meta.newValue.updatedAt <= data.updatedAt) return;
    try {
      const remote = await pullSync();
      if (remote && remote.updatedAt > data.updatedAt) {
        data = mergeRemote(remote, data);
        await saveLocalOnly(data);
        applySettings();
        safeRender();
        renderPad(true);
      }
    } catch (e) { console.warn(e); }
  } else if (area === 'session' && ch.unlockedUntil) {
    unlockedUntil = ch.unlockedUntil.newValue || 0;
    safeRender();
  }
}

function save() { return saveData(data); }

const S = () => data.settings;
const currentGroup = () => data.groups.find(g => g.id === data.activeGroup) || data.groups[0];

/* ================= blokada PIN ================= */

const isUnlocked = () => Date.now() < unlockedUntil;
const groupVisible = g => !g.locked || !S().pinHash || isUnlocked();
const hasLockedGroups = () => !!S().pinHash && data.groups.some(g => g.locked);

async function setUnlocked(on) {
  unlockedUntil = on ? Date.now() + UNLOCK_MS : 0;
  try { await chrome.storage.session.set({ unlockedUntil }); } catch {}
  render();
}

let wasUnlocked = false;
function checkLockExpiry() {
  const now = isUnlocked();
  if (wasUnlocked && !now) render();
  wasUnlocked = now;
}

async function verifyPin(pin) {
  const s = S();
  if (!s.pinHash) return true;
  return (await hashPin(pin, s.pinSalt)) === s.pinHash;
}

/* ================= wygląd ================= */

function applySettings() {
  const s = S();
  const root = document.documentElement.style;
  root.setProperty('--cols', s.columns);
  root.setProperty('--tile-w', (s.layout === 'classic' ? TILE_W_CLASSIC : TILE_W)[s.tileSize] + 'px');
  root.setProperty('--gap', s.tileSize === 's' ? '16px' : s.tileSize === 'l' ? '26px' : '20px');
  document.body.classList.toggle('light', s.theme === 'light');
  document.body.classList.toggle('classic', s.layout === 'classic');
  root.setProperty('--title-font', TITLE_FONTS[s.titleFont] || 'inherit');
  root.setProperty('--title-size', (s.titleSize || 13) + 'px');
  root.setProperty('--title-weight', s.titleBold ? '700' : '500');
  document.body.classList.toggle('custom-title-color', !!s.titleColor);
  if (s.titleColor) root.setProperty('--title-color', s.titleColor); else root.removeProperty('--title-color');
  document.body.dataset.frame = s.frame || 'normal';
  root.setProperty('--tile-bg-a', String((s.tileBgAlpha ?? 0) / 100));
  document.body.classList.toggle('glass', s.tileStyle === 'glass');
  document.body.classList.toggle('clear-tiles', s.tileStyle === 'clear');
  document.body.classList.toggle('clear-icons', s.iconStyle !== 'box');
  document.body.classList.toggle('custom-icon-size', s.iconSize > 0);
  if (s.iconSize > 0) {
    root.setProperty('--icon-size', s.iconSize + '%');
    root.setProperty('--icon-size-n', String(s.iconSize / 100 * 0.8));
  } else { root.removeProperty('--icon-size'); root.removeProperty('--icon-size-n'); }
  document.body.classList.toggle('no-titles', !s.showTitles);
  $('#clock').hidden = !s.showClock;
  document.body.dataset.hover = s.tileHover || 'lift';
  if (typeof updatePadButton === 'function' && data.pad) updatePadButton();
  if (s.fx !== appliedFx.k || s.fxAmount !== appliedFx.a) { appliedFx = { k: s.fx, a: s.fxAmount }; setFx(s.fx, s.fxAmount); }
  $('#search').hidden = !s.showSearch;
  applyBackground();
}

const groupBgImages = new Map();   // id grupy -> zdjęcie tła
let appliedFx = { k: null, a: null };
let cropDraft = null;              // kadr ustawiany na żywo
let rotateImages = [];             // zmieniające się zdjęcia
let rotateOpenIdx = null;

function effectiveBg() {
  const s = S();
  const g = !viewRecent && currentGroup();
  const o = g?.bg;
  if (o && o.type) {
    return { type: o.type, gradient: o.i ?? s.bgGradient, color: o.v || s.bgColor,
      image: o.type === 'image' ? groupBgImages.get(g.id) : bgImage, pos: o.pos || null, owner: g };
  }
  return { type: s.bgType, gradient: s.bgGradient, color: s.bgColor, image: bgImage, pos: s.bgPos || null, owner: null };
}
const PHOTO_BG = ['image', 'bing', 'rotate', 'wood'];

// kadr zdjęcia: położenie (x, y w %) i przybliżenie (z w %)
function applyCrop(pos, type) {
  const bg = $('#bg');
  if (!PHOTO_BG.includes(type)) { bg.style.transform = ''; return; }
  const p = pos || { x: 50, y: 50, z: 100 };
  bg.style.backgroundPosition = `${p.x}% ${p.y}%`;
  bg.style.transformOrigin = `${p.x}% ${p.y}%`;
  bg.style.transform = p.z > 100 ? `scale(${p.z / 100})` : '';
}

function rotatePick() {
  const n = rotateImages.length;
  if (!n) return null;
  const mode = S().rotateMode;
  let i;
  if (mode === 'hour') i = Math.floor(Date.now() / 36e5) % n;
  else if (mode === 'open') { if (rotateOpenIdx === null || rotateOpenIdx >= n) rotateOpenIdx = Math.floor(Math.random() * n); i = rotateOpenIdx; }
  else { const d = new Date(); i = (d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate()) % n; }
  return rotateImages[i];
}

function applyBackground() {
  const s = S();
  const e = effectiveBg();
  const bg = $('#bg');
  const dim = $('#bg-dim');
  const credit = $('#bing-credit');
  credit.hidden = true;
  dim.style.opacity = 0;
  if (e.type === 'rotate' && rotatePick()) {
    bg.style.background = `#000 url("${rotatePick()}") center / cover no-repeat`;
    dim.style.opacity = s.bgDim / 100;
  } else if (e.type === 'image' && e.image) {
    bg.style.background = `#000 url("${e.image}") center / cover no-repeat`;
    dim.style.opacity = s.bgDim / 100;
  } else if (e.type === 'bing') {
    dim.style.opacity = s.bgDim / 100;
    loadBing();
  } else if (e.type === 'wood') {
    bg.style.background = `#262626 url("${woodTexture()}") center / cover no-repeat`;
    dim.style.opacity = s.bgDim / 100;
  } else if (e.type === 'color') {
    bg.style.background = e.color;
  } else {
    bg.style.background = GRADIENTS[e.gradient] || GRADIENTS[0];
  }
  applyCrop(cropDraft || e.pos, e.type);
}

/* ---------- tło: ciemne deski (rysowane w przeglądarce) ---------- */

let woodCache = null;
function woodTexture() {
  if (woodCache) return woodCache;
  const W = 1920, H = 1200;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const plankW = 120;
  for (let x = 0, i = 0; x < W; x += plankW, i++) {
    const base = 34 + Math.floor(rnd() * 16);            // odcień deski
    g.fillStyle = `rgb(${base},${base},${base + 1})`;
    g.fillRect(x, 0, plankW, H);
    // słoje
    for (let k = 0; k < 70; k++) {
      const gx = x + rnd() * plankW;
      const amp = 1 + rnd() * 5, freq = 0.002 + rnd() * 0.01, ph = rnd() * 6.28;
      const light = rnd() < 0.5;
      g.strokeStyle = light ? `rgba(255,255,255,${0.02 + rnd() * 0.05})` : `rgba(0,0,0,${0.05 + rnd() * 0.12})`;
      g.lineWidth = 0.5 + rnd() * 1.6;
      g.beginPath();
      for (let y = 0; y <= H; y += 12) {
        const px = gx + Math.sin(y * freq + ph) * amp;
        y === 0 ? g.moveTo(px, y) : g.lineTo(px, y);
      }
      g.stroke();
    }
    // sęki
    for (let k = 0; k < 2; k++) if (rnd() < 0.35) {
      const kx = x + 20 + rnd() * (plankW - 40), ky = rnd() * H;
      const r = 6 + rnd() * 10;
      const grad = g.createRadialGradient(kx, ky, 1, kx, ky, r * 2.2);
      grad.addColorStop(0, 'rgba(0,0,0,.45)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(kx, ky, r, r * 2.2, 0, 0, 6.28); g.fill();
    }
    // szczelina między deskami
    const sh = g.createLinearGradient(x, 0, x + 6, 0);
    sh.addColorStop(0, 'rgba(0,0,0,.75)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh;
    g.fillRect(x, 0, 6, H);
    g.fillStyle = 'rgba(255,255,255,.04)';
    g.fillRect(x + plankW - 1, 0, 1, H);
  }
  // winieta
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,.45)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  woodCache = c.toDataURL('image/jpeg', 0.85);
  return woodCache;
}

/* ---------- tapeta dnia Bing ---------- */

const todayStr = () => new Date().toLocaleDateString('sv-SE'); // RRRR-MM-DD

async function loadBing() {
  const bg = $('#bg');
  let cache = (await chrome.storage.local.get('bingCache')).bingCache;
  if (!cache || cache.date !== todayStr()) {
    try {
      const r = await fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=pl-PL');
      const j = await r.json();
      const im = j.images[0];
      cache = {
        date: todayStr(),
        url: 'https://www.bing.com' + im.url.replace(/_\d+x\d+\./, '_UHD.'),
        fallback: 'https://www.bing.com' + im.url,
        title: im.title || '',
        copyright: im.copyright || '',
        link: im.copyrightlink || 'https://www.bing.com'
      };
      await chrome.storage.local.set({ bingCache: cache });
    } catch (e) {
      if (!cache) { bg.style.background = GRADIENTS[0]; return; }
    }
  }
  if (effectiveBg().type !== 'bing') return;
  const img = new Image();
  img.onload = () => { if (effectiveBg().type === 'bing') { bg.style.background = `#000 url("${img.src}") center / cover no-repeat`; applyCrop(cropDraft || effectiveBg().pos, 'bing'); } };
  img.onerror = () => { if (img.src !== cache.fallback) img.src = cache.fallback; };
  img.src = cache.url;
  const credit = $('#bing-credit');
  credit.textContent = '📷 ' + [cache.title, cache.copyright].filter(Boolean).join(' — ');
  credit.href = cache.link;
  credit.hidden = false;
}

/* ---------- ikony ---------- */

function autoColor(url) {
  const h = hostOf(url);
  let x = 0;
  for (const c of h) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 55% 42%)`;
}

function chromeFavicon(pageUrl, size = 64) {
  if (IS_FIREFOX) return gstaticIcon(pageUrl, Math.max(size, 64)); // Firefox nie ma wbudowanych ikon _favicon
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}

function gstaticIcon(url, size = 256) {
  let origin = url;
  try { origin = new URL(url).origin; } catch {}
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=${size}`;
}

// prośby o lepsze ikony – zbierane i wysyłane paczką do tła
const iconWanted = new Set();
const iconAsked = new Set();
let iconTimer;
function wantIcon(url, force = false) {
  if (!/^https?:/i.test(url)) return;
  iconWanted.add(url);
  clearTimeout(iconTimer);
  iconTimer = setTimeout(() => {
    const urls = [...iconWanted];
    iconWanted.clear();
    chrome.runtime.sendMessage({ type: 'resolveIcons', urls, force }).catch(() => {});
  }, force ? 0 : 200);
}

function favImg(url, tile) {
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  if (tile?.icon) {
    img.src = tile.icon;
    return img;
  }
  const rec = icons.get(hostOf(url));
  if (rec?.img) {
    img.src = rec.img;
    if (rec.opaque) img.classList.add('opaque');
    if (!rec.svg && rec.w < 64) img.classList.add('lowres');
    // ikona pobrana wcześniej tylko z Google albo stara -> poproś o lepszą (raz na otwarcie karty)
    if ((!rec.viaPage || Date.now() - rec.at > 30 * 24 * 3600e3) && !iconAsked.has(hostOf(url))) {
      iconAsked.add(hostOf(url));
      wantIcon(url);
    }
    return img;
  }
  if (!rec?.fail) wantIcon(url);
  img.src = gstaticIcon(url);
  img.onerror = () => { img.onerror = null; img.src = chromeFavicon(url); };
  return img;
}

function applyTileIconSize(wrap, pct) {
  wrap.style.setProperty('width', pct + '%', 'important');
  wrap.style.setProperty('max-width', 'none', 'important');
  wrap.classList.add('sized');
}

function badgeFor(url) {
  if (!S().badges) return 0;
  return badges[hostOf(url)]?.n || 0;
}
function badgeEl(n) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = n > 99 ? '99+' : n;
  return b;
}

/* ================= rysowanie ================= */

function safeRender() {
  if (dragId) { pendingRender = true; return; }
  render();
}

function render() {
  renderGroups();
  renderGrid(false);
  if (openFolderId) renderFolder();
  $('#btn-lock').hidden = !(hasLockedGroups() && isUnlocked());
}

function renderGroups() {
  const nav = $('#groups');
  nav.innerHTML = '';
  for (const g of data.groups) {
    const b = document.createElement('button');
    b.className = 'group-tab' + (g.id === data.activeGroup && !viewRecent ? ' active' : '');
    b.textContent = (g.locked && S().pinHash ? (isUnlocked() ? '🔓 ' : '🔒 ') : '') + g.name;
    if (g.color) { b.classList.add('colored'); b.style.setProperty('--gc', g.color); }
    b.title = 'Kliknij dwukrotnie, aby zmienić nazwę';
    b.onclick = () => switchGroup(g.id);
    b.ondblclick = () => renameGroup(g);
    b.oncontextmenu = e => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); };
    b.dataset.gid = g.id;
    b.draggable = !RO();
    b.ondragstart = e => {
      groupDragId = g.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
      requestAnimationFrame(() => b.classList.add('dragging'));
    };
    b.ondragend = () => {
      b.classList.remove('dragging');
      if (!groupDragId) return;
      groupDragId = null;
      const order = [...document.querySelectorAll('#groups .group-tab[data-gid]')].map(x => x.dataset.gid);
      const byId = new Map(data.groups.map(x => [x.id, x]));
      const next = order.map(id => byId.get(id)).filter(Boolean);
      if (next.length === data.groups.length && next.some((x, i) => x !== data.groups[i])) { data.groups = next; save(); }
      renderGroups();
    };
    b.ondragover = e => {
      if (groupDragId) {
        e.preventDefault();
        const dragging = document.querySelector(`#groups .group-tab[data-gid="${CSS.escape(groupDragId)}"]`);
        if (!dragging || dragging === b) return;
        const r = b.getBoundingClientRect();
        b.parentNode.insertBefore(dragging, e.clientX > r.left + r.width / 2 ? b.nextSibling : b);
        return;
      }
      if (!dragId && !RO() && hasLink(e.dataTransfer) && groupVisible(g)) {
        // link z zewnątrz (inna karta, zakładki, pulpit) – doda się do tej grupy
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        b.classList.add('drop-target');
        return;
      }
      if (!dragId || g.id === data.activeGroup || !groupVisible(g)) return;
      e.preventDefault();
      b.classList.add('drop-target');
      // przytrzymaj kafelek nad zakładką – przeniesie się do tej grupy i grupa się otworzy
      if (!hoverTimer) hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (!dragId) return;
        const id = dragId;
        dragHandled = true;
        dragId = null;
        pendingRender = false;
        moveItemToGroup(id, g.id);
        switchGroup(g.id);
      }, 750);
    };
    b.ondragleave = () => { b.classList.remove('drop-target'); clearTimeout(hoverTimer); hoverTimer = null; };
    b.ondrop = e => {
      e.preventDefault();
      clearTimeout(hoverTimer); hoverTimer = null;
      b.classList.remove('drop-target');
      if (dragId) { dragHandled = true; moveItemToGroup(dragId, g.id); }
      else if (!groupDragId && !RO()) { e.stopPropagation(); dropLinks(e.dataTransfer, g.id); }
    };
    nav.append(b);
  }
  if (S().showRecent && chrome.sessions) {
    const r = document.createElement('button');
    r.className = 'group-tab recent' + (viewRecent ? ' active' : '');
    r.textContent = '🕘 Ostatnio zamknięte';
    r.onclick = () => { viewRecent = true; renderGroups(); renderGrid(true); applyBackground(); };
    nav.append(r);
  }
  const add = document.createElement('button');
  add.className = 'group-tab add';
  add.textContent = '+';
  add.title = 'Nowa grupa';
  add.onclick = () => newGroup();
  nav.append(add);
}

function switchGroup(id) {
  if (selected.size) clearSelection();
  if (viewRecent) { viewRecent = false; data.activeGroup = id; save(); renderGroups(); renderGrid(true); applyBackground(); return; }
  if (id === data.activeGroup) return;
  data.activeGroup = id;
  save();
  renderGroups();
  renderGrid(true);
  applyBackground();
}

function renderGrid(anim) {
  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.remove('anim');
  const g = currentGroup();

  if (viewRecent) { renderRecent(grid); if (anim) { void grid.offsetWidth; grid.classList.add('anim'); } return; }

  if (!groupVisible(g)) {
    grid.append(lockPanel(g));
    return;
  }

  g.tiles.forEach((it, i) => {
    const el = isFolder(it) ? folderEl(it) : tileEl(it, null);
    el.style.setProperty('--i', i);
    if (i < 9) {
      const k = document.createElement('span');
      k.className = 'key-hint';
      k.textContent = i + 1;
      el.append(k);
    }
    grid.append(el);
  });

  if (S().showAddTile && !RO()) {
    const add = addTileEl(() => openTileModal(null, null));
    add.style.setProperty('--i', g.tiles.length);
    grid.append(add);
  } else if (!g.tiles.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'Pusta grupa – kliknij prawym przyciskiem myszy na tle i wybierz „Dodaj stronę…”, albo przeciągnij tu link.';
    grid.append(hint);
  }

  if (anim) { void grid.offsetWidth; grid.classList.add('anim'); }
}

async function renderRecent(grid) {
  let list = [];
  try { list = await chrome.sessions.getRecentlyClosed({ maxResults: 25 }); } catch {}
  if (!viewRecent) return;
  grid.innerHTML = '';
  const tabs = [];
  for (const e of list) {
    if (e.tab) tabs.push({ s: e.tab, at: e.lastModified });
    else if (e.window) tabs.push({ s: e.window, at: e.lastModified, win: true });
  }
  const real = tabs.filter(x => x.win || /^(https?|file|ftp):/.test(x.s.url || ''));
  if (!real.length) {
    const h = document.createElement('div');
    h.className = 'empty-hint';
    h.textContent = 'Brak ostatnio zamkniętych kart.';
    grid.append(h);
    return;
  }
  real.forEach((x, i) => {
    const a = document.createElement('a');
    a.className = 'tile recent-tile';
    a.href = x.win ? '#' : x.s.url;
    a.style.setProperty('--i', i);
    const thumb = document.createElement('div');
    thumb.className = 'thumb plain';
    thumb.style.background = x.win ? '#4a5068' : autoColor(x.s.url);
    const w = document.createElement('div');
    w.className = 'fav-wrap';
    if (x.win) { w.innerHTML = '<span class="emoji-icon">🗔</span>'; }
    else w.append(favImg(x.s.url));
    thumb.append(w);
    const ago = document.createElement('span');
    ago.className = 'recent-ago';
    ago.textContent = timeAgo(x.at * 1000);
    thumb.append(ago);
    const title = document.createElement('div');
    title.className = 'title';
    const tt = document.createElement('span');
    tt.className = 't-text';
    tt.textContent = x.win ? `Okno (${x.s.tabs?.length || 0} kart)` : (x.s.title || hostOf(x.s.url));
    title.append(tt);
    a.title = x.win ? 'Przywróć całe okno' : `${x.s.title}\n${x.s.url}`;
    a.append(thumb, title);
    a.onclick = e => { e.preventDefault(); chrome.sessions.restore(x.s.sessionId); };
    a.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      if (x.win) return;
      showMenu(e.clientX, e.clientY, [
        { label: 'Przywróć kartę', action: () => chrome.sessions.restore(x.s.sessionId) },
        { label: 'Dodaj do kafelków', action: () => { const t = addTile(data, data.activeGroup, { url: x.s.url, title: x.s.title }); save(); toast(`Dodano „${t.title}” do „${currentGroup().name}”`); } }
      ]);
    };
    grid.append(a);
  });
}

function timeAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'przed chwilą';
  if (m < 60) return `${m} min temu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} godz. temu`;
  return `${Math.round(h / 24)} dni temu`;
}

function addTileEl(onClick) {
  const add = document.createElement('a');
  add.className = 'tile add-tile';
  add.href = '#';
  add.innerHTML = '<div class="thumb">+</div><div class="title">Dodaj</div>';
  add.onclick = e => { e.preventDefault(); onClick(); };
  return add;
}

function lockPanel(g) {
  const p = document.createElement('form');
  p.className = 'lock-panel';
  p.innerHTML = `<div class="big">🔒</div><div>Grupa „<b></b>” jest chroniona PIN-em</div>
    <input type="password" inputmode="numeric" autocomplete="off" placeholder="PIN">
    <button class="btn primary" type="submit">Odblokuj</button><div class="error"></div>`;
  p.querySelector('b').textContent = g.name;
  const inp = p.querySelector('input');
  p.onsubmit = async e => {
    e.preventDefault();
    if (await verifyPin(inp.value)) {
      setUnlocked(true);
      renderGrid(true);
    } else {
      p.querySelector('.error').textContent = 'Nieprawidłowy PIN';
      inp.value = '';
      p.classList.remove('shake'); void p.offsetWidth; p.classList.add('shake');
    }
  };
  setTimeout(() => inp.focus(), 50);
  return p;
}

function tileEl(t, folder) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = t.url;
  a.title = `${t.title}\n${t.url}`;
  a.draggable = !RO();
  a.dataset.id = t.id;
  if (selected.has(t.id)) a.classList.add('selected');
  if (S().openInNewTab) { a.target = '_blank'; a.rel = 'noopener'; }
  a.addEventListener('click', e => {
    if (!RO() && (e.ctrlKey || e.metaKey || e.shiftKey || selected.size)) { e.preventDefault(); toggleSelect(t.id, e.shiftKey); return; }
    if (t.incognito) { e.preventDefault(); openIncognito([t.url]); }
  });
  a.addEventListener('auxclick', e => { if (e.button === 1 && t.incognito) { e.preventDefault(); openIncognito([t.url]); } });

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (t.incognito) { const ic = document.createElement('span'); ic.className = 'incog-badge'; ic.title = 'Otwiera się w oknie incognito'; ic.textContent = '🕶'; setTimeout(() => thumb.append(ic)); }
  const shot = thumbs.get(t.id) && (t.preview === true || (t.preview !== false && S().thumbnails)) && thumbs.get(t.id);

  if (t.image && (t.imageFit || 'contain') === 'contain') {
    // logo „zmieszczone” leży na zwykłym tle kafelka – przezroczystość zostaje zachowana
    thumb.classList.add('plain', 'img-contain');
    thumb.style.background = t.color || autoColor(t.url);
    const im = document.createElement('img');
    im.className = 'tile-img';
    im.alt = '';
    im.draggable = false;
    im.src = t.image;
    thumb.append(im);
  } else if (t.image) {
    thumb.style.backgroundImage = `url("${t.image}")`;
  } else if (t.emoji) {
    thumb.classList.add('plain');
    thumb.style.background = t.color || autoColor(t.url);
    const e = document.createElement('span');
    e.className = 'emoji-icon';
    e.textContent = t.emoji;
    if (t.iconSize > 0) e.style.fontSize = `calc(var(--tile-w) * ${t.iconSize / 100 * 0.8})`;
    thumb.append(e);
  } else if (shot) {
    thumb.classList.add('shot');
    thumb.style.backgroundImage = `url("${shot}")`;
    const m = document.createElement('div');
    m.className = 'mini-fav';
    m.append(favImg(t.url, t));
    thumb.append(m);
  } else {
    thumb.classList.add('plain');
    thumb.style.background = t.color || autoColor(t.url);
    const w = document.createElement('div');
    w.className = 'fav-wrap';
    w.append(favImg(t.url, t));
    if (t.iconSize > 0) applyTileIconSize(w, t.iconSize);
    thumb.append(w);
  }

  const title = document.createElement('div');
  title.className = 'title';
  let tf;
  if (t.emoji && !t.icon) { tf = document.createElement('span'); tf.className = 't-fav t-emoji'; tf.textContent = t.emoji; }
  else { tf = favImg(t.url, t); tf.className = (tf.className + ' t-fav').trim(); }
  const tt = document.createElement('span');
  tt.className = 't-text';
  tt.textContent = t.title;
  title.append(tf, tt);

  const more = document.createElement('button');
  more.className = 'more';
  more.type = 'button';
  more.textContent = '⋯';
  more.title = 'Opcje';
  more.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const r = more.getBoundingClientRect();
    tileMenu(t, folder, r.left, r.bottom + 4);
  };

  a.append(thumb, title, more);
  const n = badgeFor(t.url);
  if (n) a.append(badgeEl(n));
  if (t.note) {
    a.title += `\n📝 ${t.note}`;
    if (S().showNotes) {
      const nt = document.createElement('div');
      nt.className = 'tile-note';
      nt.textContent = t.note;
      a.append(nt);
    }
  }
  const h = health[t.id];
  if (h && !h.ok) {
    const d = document.createElement('span');
    d.className = 'down-dot';
    d.title = `Strona nie odpowiada${h.status ? ' (kod ' + h.status + ')' : ''} – sprawdzono ${new Date(h.at).toLocaleString('pl-PL')}`;
    thumb.append(d);
    a.title += '\n⚠ ' + d.title;
  }
  const c = changes[t.id];
  if (t.watch && c?.n) {
    const nb = document.createElement('span');
    nb.className = 'new-badge';
    nb.textContent = `NOWE ${c.n > 9 ? '9+' : c.n}`;
    nb.title = 'Nowości na stronie:\n• ' + (c.items || []).join('\n• ');
    thumb.append(nb);
  } else if (t.watch) {
    const w = document.createElement('span');
    w.className = 'watch-eye';
    w.title = 'Obserwujesz zmiany na tej stronie';
    w.textContent = '👁';
    thumb.append(w);
  }
  a.addEventListener('mousedown', ev => { if (ev.button <= 1 && changes[t.id]) clearChanges(t.id); });

  a.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); tileMenu(t, folder, e.clientX, e.clientY); };
  bindDrag(a, t.id);
  return a;
}

function folderEl(f) {
  const a = document.createElement('a');
  a.className = 'tile folder-tile';
  a.href = '#';
  a.title = `${f.title} (${f.tiles.length})`;
  a.draggable = true;
  a.dataset.id = f.id;
  a.dataset.folder = '1';

  const thumb = document.createElement('div');
  thumb.className = 'thumb folder';
  const icons = document.createElement('div');
  icons.className = 'folder-icons';
  f.tiles.slice(0, 4).forEach(t => {
    const s = document.createElement('span');
    if (t.emoji) s.textContent = t.emoji; else s.append(favImg(t.url, t));
    icons.append(s);
  });
  thumb.append(icons);

  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = '<span class="t-folder">📁</span><span class="t-text"></span>';
  title.querySelector('.t-text').textContent = f.title;

  const more = document.createElement('button');
  more.className = 'more';
  more.type = 'button';
  more.textContent = '⋯';
  more.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const r = more.getBoundingClientRect();
    folderMenu(f, r.left, r.bottom + 4);
  };

  a.append(thumb, title, more);
  const n = f.tiles.reduce((s, t) => s + badgeFor(t.url), 0);
  if (n) a.append(badgeEl(n));

  a.onclick = e => {
    e.preventDefault();
    if (!RO() && (e.ctrlKey || e.metaKey || e.shiftKey || selected.size)) { toggleSelect(f.id, e.shiftKey); return; }
    openFolder(f.id);
  };
  if (selected.has(f.id)) a.classList.add('selected');
  a.draggable = !RO();
  a.onauxclick = e => { if (e.button === 1) { e.preventDefault(); openAll(f.tiles); } };
  a.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); folderMenu(f, e.clientX, e.clientY); };
  bindDrag(a, f.id);
  return a;
}

/* ================= menu ================= */

function tileMenu(t, folder, x, y) {
  if (RO()) {
    return showMenu(x, y, [
      { label: t.incognito ? '🕶 Otwórz (incognito)' : 'Otwórz', action: () => t.incognito ? openIncognito([t.url]) : (location.href = t.url) },
      { label: 'Otwórz w nowej karcie', action: () => chrome.tabs.create({ url: t.url, active: false }) },
      { label: '🕶 Otwórz w oknie incognito', action: () => openIncognito([t.url]) },
      { label: 'Kopiuj adres', action: () => navigator.clipboard.writeText(t.url).then(() => toast('Skopiowano adres')) },
      '-',
      { label: '🔓 Odblokuj edycję', action: () => setReadOnly(false) }
    ]);
  }
  const g = findItem(data, t.id).group;
  const others = data.groups.filter(x => x.id !== g?.id && groupVisible(x));
  const items = [
    { label: 'Otwórz w nowej karcie', action: () => chrome.tabs.create({ url: t.url, active: false }) },
    { label: '🕶 Otwórz w oknie incognito', action: () => openIncognito([t.url]) },
    { label: 'Edytuj', action: () => openTileModal(t, folder) },
    { label: selected.has(t.id) ? '☐ Odznacz' : '☑ Zaznacz (Ctrl+klik)', action: () => toggleSelect(t.id) },
    { label: t.incognito ? '🕶 Otwieraj normalnie' : '🕶 Zawsze otwieraj w incognito', action: () => { const it = findItem(data, t.id).item; if (it.incognito) delete it.incognito; else it.incognito = true; save(); render(); } },
    { label: 'Kopiuj adres', action: () => navigator.clipboard.writeText(t.url).then(() => toast('Skopiowano adres')) }
  ];
  if (/^https?:/.test(t.url)) {
    items.push({ label: t.watch ? '👁 Przestań obserwować zmiany' : '👁 Obserwuj zmiany na stronie', action: () => toggleWatch(t) });
    if (changes[t.id]) items.push({ label: 'Oznacz nowości jako przeczytane', action: () => clearChanges(t.id) });
  }
  if (!t.image) {
    items.push({ label: '➕ Większa ikona', action: () => bumpIconSize(t, +6) });
    items.push({ label: '➖ Mniejsza ikona', action: () => bumpIconSize(t, -6) });
  }
  if (!t.icon && /^https?:/.test(t.url))
    items.push({ label: 'Odśwież ikonę', action: async () => {
      await chrome.storage.local.remove('icon_' + hostOf(t.url));
      wantIcon(t.url, true);
      toast('Szukam lepszej ikony…');
    } });
  if (/^https?:/.test(t.url)) {
    const hasShot = thumbs.has(t.id);
    const showing = hasShot && (t.preview === true || (t.preview !== false && S().thumbnails));
    items.push('-', { text: 'Podgląd strony' });
    items.push({ label: hasShot ? '📸 Odśwież podgląd' : '📸 Zrób podgląd strony', action: () => captureOne(t) });
    if (hasShot && !showing) items.push({ label: '🖼️ Pokaż podgląd zamiast logo', action: () => setPreview(t, true) });
    if (showing) items.push({ label: '🔷 Pokaż logo zamiast podglądu', action: () => setPreview(t, false) });
    if (hasShot) items.push({ label: 'Usuń podgląd', action: () => { setPreview(t, null); chrome.storage.local.remove('thumb_' + t.id); } });
  }
  if (folder) items.push({ label: 'Wyjmij z folderu', action: () => moveOutOfFolder(t.id) });
  if (others.length) {
    items.push('-', { text: 'Przenieś do grupy' });
    others.forEach(o => items.push({ label: '→ ' + o.name, action: () => moveItemToGroup(t.id, o.id) }));
  }
  items.push('-', { label: 'Usuń', danger: true, action: () => deleteItem(t.id) });
  showMenu(x, y, items);
}

function folderMenu(f, x, y) {
  const others = data.groups.filter(g => g.id !== data.activeGroup && groupVisible(g));
  const items = [
    { label: 'Otwórz folder', action: () => openFolder(f.id) },
    { label: `Otwórz wszystkie (${f.tiles.length})`, action: () => openAll(f.tiles), disabled: !f.tiles.length },
    { label: 'Zmień nazwę', action: () => openNameModal({ title: 'Nazwa folderu', value: f.title, onSave: v => { f.title = v; save(); render(); } }) },
    { label: 'Rozwiąż folder', action: () => dissolveFolder(f.id) }
  ];
  if (others.length) {
    items.push('-', { text: 'Przenieś do grupy' });
    others.forEach(o => items.push({ label: '→ ' + o.name, action: () => moveItemToGroup(f.id, o.id) }));
  }
  items.push('-', { label: 'Usuń folder', danger: true, action: () => {
    if (f.tiles.length && !confirm(`Usunąć folder „${f.title}” razem z ${f.tiles.length} kafelkami?`)) return;
    deleteItem(f.id);
  } });
  showMenu(x, y, items);
}

function groupMenu(g, x, y) {
  const visible = groupVisible(g);
  const flat = g.tiles.flatMap(it => isFolder(it) ? it.tiles : [it]);
  if (RO()) {
    return showMenu(x, y, [
      { label: `Otwórz wszystkie (${flat.length})`, action: () => openAll(flat), disabled: !visible || !flat.length },
      '-',
      { label: '🔓 Odblokuj edycję', action: () => setReadOnly(false) }
    ]);
  }
  const items = [
    { label: `Otwórz wszystkie (${flat.length})`, action: () => openAll(flat), disabled: !visible || !flat.length },
    { label: 'Zmień nazwę', action: () => renameGroup(g) },
    { label: '🎨 Kolor zakładki…', action: () => openGroupColor(g) },
    { label: '🖼️ Tło tej grupy…', action: () => openGroupBg(g) },
    { label: 'Przesuń w lewo', action: () => moveGroup(g, -1), disabled: data.groups[0] === g },
    { label: 'Przesuń w prawo', action: () => moveGroup(g, 1), disabled: data.groups.at(-1) === g },
    '-'
  ];
  if (g.locked && S().pinHash) {
    items.push({ label: '🔓 Usuń blokadę PIN', action: () => {
      if (!isUnlocked()) { switchGroup(g.id); toast('Najpierw odblokuj grupę PIN-em'); return; }
      g.locked = false; save(); render();
    } });
  } else {
    items.push({ label: '🔒 Zablokuj PIN-em', action: () => {
      if (!S().pinHash) {
        openPinModal('set', () => { g.locked = true; save(); setUnlocked(false); });
      } else { g.locked = true; save(); setUnlocked(false); }
    } });
  }
  items.push('-', { label: 'Usuń grupę', danger: true, action: () => deleteGroup(g), disabled: data.groups.length < 2 || !visible });
  showMenu(x, y, items);
}

function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(document.createElement('hr')); continue; }
    if (it.text) {
      const d = document.createElement('div');
      d.className = 'label';
      d.textContent = it.text;
      m.append(d);
      continue;
    }
    if (it.disabled) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { hideMenu(); it.action(); };
    m.append(b);
  }
  if (m.lastChild?.tagName === 'HR') m.lastChild.remove();
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function hideMenu() { $('#menu').hidden = true; }

/* ================= operacje ================= */

function bumpIconSize(t, delta) {
  const it = findItem(data, t.id).item;
  if (!it) return;
  const base = it.iconSize || S().iconSize || 42;
  it.iconSize = Math.max(15, Math.min(60, base + delta));
  save();
  render();
  toast(`Wielkość ikony: ${it.iconSize}%`);
}

async function clearChanges(id) {
  delete changes[id];
  await chrome.storage.local.set({ changes });
}

function toggleWatch(t) {
  const it = findItem(data, t.id).item;
  if (!it) return;
  if (it.watch) { delete it.watch; clearChanges(it.id); chrome.storage.local.remove('watch_' + it.id); }
  else it.watch = true;
  save();
  render();
  if (it.watch) {
    toast('👁 Obserwuję – pierwsze sprawdzenie zapamięta stan strony');
    chrome.runtime.sendMessage({ type: 'monitorNow' }).catch(() => {});
  }
}

function setPreview(t, val) {
  const it = findItem(data, t.id).item;
  if (!it) return;
  if (val === null) delete it.preview; else it.preview = val;
  save();
  render();
}

function captureOne(t) {
  const it = findItem(data, t.id).item;
  if (it && it.preview !== true) { it.preview = true; save(); }
  chrome.runtime.sendMessage({ type: 'captureAll', ids: [t.id] }).catch(() => {});
  toast('📸 Robię podgląd – na chwilę otworzy się okno');
}

/* ---------- incognito ---------- */
function openIncognito(urls) {
  chrome.windows.create({ url: urls, incognito: true }).catch(e => toast('Nie udało się otworzyć okna incognito: ' + (e.message || e)));
}

/* ---------- tryb tylko do odczytu ---------- */
function setReadOnly(on) {
  if (on) clearSelection();
  setSetting('readOnly', on);
  render();
  updateReadOnlyUI();
  toast(on ? '🔒 Układ zablokowany – kafelki można tylko otwierać' : '🔓 Edycja odblokowana');
}
function updateReadOnlyUI() {
  document.body.classList.toggle('read-only', RO());
  $('#btn-readonly').hidden = !RO();
  const sw = $('#s-readOnly');
  if (sw) sw.checked = RO();
}

/* ---------- zaznaczanie wielu kafelków ---------- */
let lastSelected = null;
function toggleSelect(id, range = false) {
  const ids = [...document.querySelectorAll('#grid .tile[data-id]')].map(x => x.dataset.id);
  if (range && lastSelected && ids.includes(lastSelected) && ids.includes(id)) {
    const [a, b] = [ids.indexOf(lastSelected), ids.indexOf(id)].sort((x, y) => x - y);
    ids.slice(a, b + 1).forEach(x => selected.add(x));
  } else if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  lastSelected = id;
  document.querySelectorAll('.tile[data-id]').forEach(el => el.classList.toggle('selected', selected.has(el.dataset.id)));
  updateSelBar();
}
function clearSelection() {
  selected.clear();
  lastSelected = null;
  document.querySelectorAll('.tile.selected').forEach(el => el.classList.remove('selected'));
  updateSelBar();
}
function selectedItems() {
  // w kolejności, w jakiej są na ekranie
  const order = [...document.querySelectorAll('.tile[data-id]')].map(x => x.dataset.id).filter(id => selected.has(id));
  return order.map(id => findItem(data, id)).filter(x => x.item);
}
function updateSelBar() {
  const bar = $('#selbar');
  bar.hidden = !selected.size;
  document.body.classList.toggle('selecting', selected.size > 0);
  $('#sel-count').textContent = `Zaznaczono: ${selected.size}`;
}
function selTiles() {
  return selectedItems().flatMap(x => isFolder(x.item) ? x.item.tiles : [x.item]);
}
async function selDelete() {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm(`Przenieść do kosza ${items.length} zaznaczonych elementów?`)) return;
  for (const x of items) {
    x.list.splice(x.list.indexOf(x.item), 1);
    await addToTrash({ kind: isFolder(x.item) ? 'folder' : 'tile', item: x.item, groupId: x.group.id, groupName: x.group.name, folderId: x.folder?.id });
  }
  cleanupFolders();
  clearSelection();
  await save();
  render();
  toast(`Przeniesiono do kosza: ${items.length} (Ustawienia → Kosz)`);
}
function selMove(groupId) {
  const target = data.groups.find(g => g.id === groupId);
  const items = selectedItems();
  for (const x of items) {
    if (x.list === target.tiles) continue;
    x.list.splice(x.list.indexOf(x.item), 1);
    target.tiles.push(x.item);
  }
  cleanupFolders();
  clearSelection();
  save();
  render();
  toast(`Przeniesiono ${items.length} do „${target.name}”`);
}
function selFolder() {
  const items = selectedItems().filter(x => !isFolder(x.item));
  if (items.length < 2) return toast('Zaznacz co najmniej 2 kafelki (bez folderów)');
  const g = currentGroup();
  const first = items.find(x => x.list === g.tiles);
  const pos = first ? g.tiles.indexOf(first.item) : g.tiles.length;
  const tiles = items.map(x => { x.list.splice(x.list.indexOf(x.item), 1); return x.item; });
  const f = makeFolder('Nowy folder', tiles);
  g.tiles.splice(Math.min(pos, g.tiles.length), 0, f);
  cleanupFolders();
  clearSelection();
  save();
  render();
  openFolder(f.id, true);
}
function selCapture() {
  const tiles = selTiles().filter(t => /^https?:/.test(t.url));
  tiles.forEach(t => { const it = findItem(data, t.id).item; if (it) it.preview = true; });
  save();
  chrome.runtime.sendMessage({ type: 'captureAll', ids: tiles.map(t => t.id) }).catch(() => {});
  clearSelection();
  toast(`📸 Robię podglądy: ${tiles.length}`);
}

function openAll(tiles) {
  const ok = tiles.filter(t => isAddableUrl(t.url));
  const urls = ok.filter(t => !t.incognito).map(t => t.url);
  const priv = ok.filter(t => t.incognito).map(t => t.url);
  if (!ok.length) return;
  if (ok.length > 10 && !confirm(`Otworzyć ${ok.length} kart?`)) return;
  urls.forEach(url => chrome.tabs.create({ url, active: false }));
  if (priv.length) openIncognito(priv);
  toast(`Otwarto ${urls.length} kart`);
}

function moveItemToGroup(id, groupId) {
  const { item, list } = findItem(data, id);
  const target = data.groups.find(g => g.id === groupId);
  if (!item || !target || list === target.tiles) return;
  list.splice(list.indexOf(item), 1);
  target.tiles.push(item);
  cleanupFolders();
  save();
  render();
  toast(`Przeniesiono do „${target.name}”`);
}

function moveOutOfFolder(id) {
  const { item, list, folder, group } = findItem(data, id);
  if (!item || !folder) return;
  list.splice(list.indexOf(item), 1);
  group.tiles.splice(group.tiles.indexOf(folder) + 1, 0, item);
  cleanupFolders();
  save();
  render();
}

function dissolveFolder(id) {
  const { item: f, list } = findItem(data, id);
  if (!isFolder(f)) return;
  list.splice(list.indexOf(f), 1, ...f.tiles);
  if (openFolderId === id) closeModals();
  save();
  render();
}

// puste foldery znikają
function cleanupFolders() {
  for (const g of data.groups) g.tiles = g.tiles.filter(it => !isFolder(it) || it.tiles.length > 0);
  if (openFolderId && !findItem(data, openFolderId).item) { openFolderId = null; closeModals(); }
}

/* ---------- kosz (30 dni) ---------- */
const TRASH_DAYS = 30;
async function getTrash() {
  const t = (await chrome.storage.local.get('trash')).trash || [];
  const fresh = t.filter(e => Date.now() - e.deletedAt < TRASH_DAYS * 864e5);
  if (fresh.length !== t.length) await chrome.storage.local.set({ trash: fresh });
  return fresh;
}
async function addToTrash(entry) {
  const t = await getTrash();
  t.unshift({ id: uid(), deletedAt: Date.now(), ...structuredClone(entry) });
  await chrome.storage.local.set({ trash: t.slice(0, 300) });
  return t[0].id;
}
async function removeFromTrash(trashId) {
  const t = await getTrash();
  await chrome.storage.local.set({ trash: t.filter(e => e.id !== trashId) });
}
function restoreEntry(e) {
  if (e.kind === 'group') {
    const g = e.group;
    if (data.groups.some(x => x.id === g.id)) g.id = uid();
    data.groups.push(g);
    return `grupa „${g.name}”`;
  }
  const g = data.groups.find(x => x.id === e.groupId) || currentGroup();
  let target = g.tiles;
  if (e.folderId) {
    const f = g.tiles.find(x => x.id === e.folderId);
    if (isFolder(f)) target = f.tiles;
  }
  if (findItem(data, e.item.id).item) e.item.id = uid();
  target.splice(Math.min(e.idx ?? target.length, target.length), 0, e.item);
  return `„${e.item.title}” → ${g.name}`;
}

let lastDeleted = null;
async function deleteItem(id) {
  const { item, list, group, folder } = findItem(data, id);
  if (!item) return;
  const idx = list.indexOf(item);
  list.splice(idx, 1);
  const trashId = await addToTrash({ kind: isFolder(item) ? 'folder' : 'tile', item, groupId: group.id, groupName: group.name, folderId: folder?.id, idx });
  lastDeleted = { item, groupId: group.id, folderId: folder?.id, idx, trashId };
  if (openFolderId === id) closeModals();
  save();
  render();
  toast(`„${item.title}” przeniesiono do kosza`, 'Cofnij', () => {
    if (!lastDeleted) return;
    const g = data.groups.find(x => x.id === lastDeleted.groupId) || data.groups[0];
    let target = g.tiles;
    if (lastDeleted.folderId) {
      const f = g.tiles.find(x => x.id === lastDeleted.folderId);
      if (f) target = f.tiles;
    }
    target.splice(Math.min(lastDeleted.idx, target.length), 0, lastDeleted.item);
    removeFromTrash(lastDeleted.trashId);
    lastDeleted = null;
    save();
    render();
  });
}

function moveGroup(g, dir) {
  const i = data.groups.indexOf(g);
  const j = i + dir;
  if (j < 0 || j >= data.groups.length) return;
  [data.groups[i], data.groups[j]] = [data.groups[j], data.groups[i]];
  save();
  renderGroups();
}

async function deleteGroup(g) {
  if (data.groups.length < 2) return;
  const n = g.tiles.length;
  if (!confirm(`Przenieść grupę „${g.name}”${n ? ` razem z zawartością (${n})` : ''} do kosza?\n\nMożesz ją przywrócić przez 30 dni (Ustawienia → Kosz).`)) return;
  await addToTrash({ kind: 'group', group: g });
  data.groups = data.groups.filter(x => x !== g);
  if (data.activeGroup === g.id) data.activeGroup = data.groups[0].id;
  save();
  render();
}

/* ---------- kolor zakładki grupy ---------- */
const GROUP_COLORS = ['#e5484d', '#f76b15', '#f5a524', '#6aa75c', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#8d8d8d', '#3b3b3b'];
let colorTarget = null;
function openGroupColor(g) {
  colorTarget = g;
  $('#gc-title').textContent = `Kolor zakładki „${g.name}”`;
  const box = $('#gc-swatches');
  box.innerHTML = '';
  GROUP_COLORS.forEach(c => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'swatch round' + (g.color === c ? ' active' : '');
    d.style.background = c;
    d.onclick = () => setGroupColor(c);
    box.append(d);
  });
  $('#gc-custom').value = g.color || '#6aa75c';
  openModal('#gcolor-modal');
}
function setGroupColor(c) {
  if (!colorTarget) return;
  if (c) colorTarget.color = c; else delete colorTarget.color;
  save();
  renderGroups();
  closeModals();
}

/* ---------- tło grupy ---------- */
let bgTarget = null;
function openGroupBg(g) {
  bgTarget = g;
  $('#gb-title').textContent = `Tło grupy „${g.name}”`;
  const box = $('#gb-gradients');
  box.innerHTML = '';
  GRADIENTS.forEach((gr, i) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'swatch' + (g.bg?.type === 'gradient' && g.bg.i === i ? ' active' : '');
    d.style.background = gr;
    d.onclick = () => setGroupBg({ type: 'gradient', i });
    box.append(d);
  });
  $('#gb-color').value = g.bg?.type === 'color' ? g.bg.v : '#1e2433';
  document.querySelectorAll('#gbg-modal .bg-choices [data-bg]').forEach(b => b.classList.toggle('active', (g.bg?.type || 'inherit') === b.dataset.bg));
  openModal('#gbg-modal');
}
async function setGroupBg(bg) {
  const g = bgTarget;
  if (!g) return;
  if (!bg) delete g.bg; else g.bg = bg;
  if (bg?.type !== 'image') { await chrome.storage.local.remove('gbg_' + g.id); groupBgImages.delete(g.id); }
  await save();
  if (g.id === data.activeGroup) applyBackground();
  closeModals();
  toast(bg ? 'Ustawiono tło grupy' : 'Grupa używa tła z ustawień');
}

/* ---------- gotowe motywy ---------- */
const THEMES = [
  { id: 'wood', name: 'Deski', prev: '#2a2a2a', set: { layout: 'classic', bgType: 'wood', frame: 'normal', tileBgAlpha: 0, theme: 'dark', showClock: false, columns: 9, tileSize: 'm', bgDim: 0 } },
  { id: 'night', name: 'Noc', prev: GRADIENTS[1], set: { layout: 'modern', bgType: 'gradient', bgGradient: 1, tileStyle: 'glass', frame: 'soft', theme: 'dark', showClock: true, columns: 6 } },
  { id: 'glass', name: 'Szkło', prev: GRADIENTS[3], set: { layout: 'modern', bgType: 'gradient', bgGradient: 3, tileStyle: 'glass', frame: 'soft', theme: 'dark', showClock: true, columns: 6 } },
  { id: 'light', name: 'Minimal jasny', prev: '#eef0f4', set: { layout: 'modern', bgType: 'color', bgColor: '#eef0f4', tileStyle: 'clear', iconStyle: 'clear', frame: 'none', theme: 'light', showClock: true, columns: 7 } },
  { id: 'bing', name: 'Tapeta dnia', prev: 'linear-gradient(135deg,#3a7bd5,#00d2ff)', set: { layout: 'modern', bgType: 'bing', bgDim: 25, tileStyle: 'glass', frame: 'normal', theme: 'dark', showClock: true, columns: 6 } },
  { id: 'color', name: 'Kolorowy', prev: GRADIENTS[0], set: { layout: 'modern', bgType: 'gradient', bgGradient: 0, tileStyle: 'color', frame: 'none', theme: 'dark', showClock: true, columns: 6 } }
];
function renderThemes() {
  const box = $('#theme-presets');
  box.innerHTML = '';
  THEMES.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-card';
    b.innerHTML = '<span class="theme-prev"><i></i><i></i><i></i></span><span class="theme-name"></span>';
    b.querySelector('.theme-prev').style.background = t.id === 'wood' ? `#2a2a2a url("${woodTexture()}") center / cover` : t.prev;
    if (t.id === 'light') b.querySelector('.theme-prev').classList.add('lt');
    b.querySelector('.theme-name').textContent = t.name;
    b.onclick = () => {
      Object.assign(S(), t.set);
      applySettings();
      save();
      render();
      openSettings('look');
      toast(`Motyw „${t.name}”`);
    };
    box.append(b);
  });
}

function newGroup() {
  openNameModal({ title: 'Nowa grupa', value: '', onSave: name => {
    const g = { id: uid(), name, locked: false, tiles: [] };
    data.groups.push(g);
    data.activeGroup = g.id;
    save();
    renderGroups();
    renderGrid(true);
  } });
}
function renameGroup(g) {
  openNameModal({ title: 'Zmień nazwę grupy', value: g.name, onSave: name => { g.name = name; save(); renderGroups(); } });
}

/* ================= przeciąganie ================= */

function bindDrag(el, id) {
  el.addEventListener('dragstart', e => {
    dragId = id;
    dragHandled = false;
    mergeTargetId = null;
    e.dataTransfer.effectAllowed = 'move';
    const it = findItem(data, id).item;
    if (it && !isFolder(it)) {
      e.dataTransfer.setData('text/uri-list', it.url);
      e.dataTransfer.setData('text/plain', it.url);
    } else e.dataTransfer.setData('text/plain', '');
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drop-target, .merge-target').forEach(x => x.classList.remove('drop-target', 'merge-target'));
    $('#folder-modal').classList.remove('drag-out');
    if (dragId && !dragHandled) commitOrder(el.parentElement);
    dragId = null;
    mergeTargetId = null;
    if (pendingRender) { pendingRender = false; render(); }
  });
}

function setMergeTarget(el) {
  const id = el?.dataset.id || null;
  if (id === mergeTargetId) return;
  document.querySelectorAll('.merge-target').forEach(x => x.classList.remove('merge-target'));
  mergeTargetId = id;
  if (el) el.classList.add('merge-target');
}

function bindContainerDnD(container, allowMerge, allowExternal) {
  container.addEventListener('dragover', e => {
    if (dragId) {
      const dragging = container.querySelector(`.tile[data-id="${CSS.escape(dragId)}"]`);
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('.tile[data-id]');
      if (!over || over === dragging) { setMergeTarget(null); return; }
      const r = over.getBoundingClientRect();
      const rx = (e.clientX - r.left) / r.width;
      const ry = (e.clientY - r.top) / r.height;
      const draggingIsFolder = !!dragging.dataset.folder;
      if (allowMerge && !draggingIsFolder && rx > .25 && rx < .75 && ry > .15 && ry < .75) {
        setMergeTarget(over);
        return;
      }
      setMergeTarget(null);
      container.insertBefore(dragging, rx > .5 ? over.nextSibling : over);
    } else if (allowExternal && !RO() && !groupDragId && hasLink(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      container.classList.add('external-drop');
    }
  });

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) container.classList.remove('external-drop');
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('external-drop');
    if (dragId) {
      if (mergeTargetId) { dragHandled = true; mergeInto(dragId, mergeTargetId); }
      return; // zmiana kolejności – w dragend
    }
    if (!allowExternal || RO() || groupDragId || viewRecent) return;
    // wstaw przed kafelkiem, na który upuszczono (prawa połowa = za nim)
    const over = e.target.closest('.tile[data-id]');
    let before = null;
    if (over) {
      const r = over.getBoundingClientRect();
      before = e.clientX > r.left + r.width / 2 ? (over.nextElementSibling?.dataset.id || null) : over.dataset.id;
    }
    dropLinks(e.dataTransfer, data.activeGroup, before, !over);
  });
}

function hasLink(dt) {
  return [...dt.types].some(t => t === 'text/uri-list' || t === 'text/plain' || t === 'text/html' || t === 'Files');
}

// odczyt linków z upuszczenia: adresy, odnośniki z tytułem (text/html), skróty internetowe .url z pulpitu
async function linksFromDrop(snap) {
  const titles = new Map();
  const lines = [];
  if (snap.html) {
    const doc = new DOMParser().parseFromString(snap.html, 'text/html');
    doc.querySelectorAll('a[href]').forEach(a => {
      const u = normalizeUrl(a.getAttribute('href'));
      const t = a.textContent.replace(/\s+/g, ' ').trim();
      if (u && t && !titles.has(u)) titles.set(u, t);
    });
  }
  lines.push(...(snap.uri || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  if (!lines.length && snap.plain) {
    lines.push(...snap.plain.split(/\s+/).filter(x => /^(https?:\/\/|www\.)\S+$/i.test(x) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(x)));
  }
  if (!lines.length) lines.push(...titles.keys());
  for (const f of snap.files) {
    if (!/\.url$/i.test(f.name)) continue;
    const m = (await f.text()).match(/^URL=(.+)$/mi);
    if (!m) continue;
    const u = normalizeUrl(m[1].trim());
    lines.push(u);
    if (u && !titles.has(u)) titles.set(u, f.name.replace(/\.url$/i, ''));
  }
  const out = [];
  for (const l of lines) {
    const u = normalizeUrl(l);
    if (u && isAddableUrl(u) && !out.some(x => x.url === u)) out.push({ url: u, title: titles.get(u) || '' });
  }
  return out;
}

function dropLinks(dt, gid, beforeId = null, atEnd = true) {
  // dane z przeciągania trzeba odczytać od razu – po pierwszym await są już niedostępne
  const snap = {
    uri: dt.getData('text/uri-list'),
    html: dt.getData('text/html'),
    plain: dt.getData('text/plain'),
    files: [...(dt.files || [])]
  };
  linksFromDrop(snap).then(links => {
    if (!links.length) {
      toast(snap.files.length ? 'Upuść link albo skrót internetowy (plik .url)' : 'To nie wygląda na adres strony');
      return;
    }
    const g = data.groups.find(x => x.id === gid);
    if (!g || !groupVisible(g)) return;
    const added = links.map(l => addTile(data, gid, l));
    if (beforeId && !atEnd) {
      const rest = g.tiles.filter(t => !added.includes(t));
      const i = rest.findIndex(t => t.id === beforeId);
      if (i >= 0) { rest.splice(i, 0, ...added); g.tiles.splice(0, g.tiles.length, ...rest); }
    }
    save();
    if (gid === data.activeGroup) renderGrid(false);
    const where = gid === data.activeGroup ? '' : ` do „${g.name}”`;
    toast(added.length === 1 ? `Dodano „${added[0].title}”${where}` : `Dodano ${added.length} ${plural(added.length, 'kafelek', 'kafelki', 'kafelków')}${where}`);
  });
}

// upuszczenie linku w dowolnym miejscu strony (poza siatką) – na koniec bieżącej grupy
function bindPageDrop() {
  const skip = e => dragId || groupDragId || RO() || viewRecent || !hasLink(e.dataTransfer) ||
    e.target.closest?.('.modal, .menu, #grid, #folder-grid, #groups, input, textarea, .news-panel, .pad-panel');
  document.addEventListener('dragover', e => {
    if (skip(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('#grid').classList.add('external-drop');
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('#grid').classList.remove('external-drop'); });
  document.addEventListener('drop', e => {
    $('#grid').classList.remove('external-drop');
    if (skip(e)) return;
    e.preventDefault();
    dropLinks(e.dataTransfer, data.activeGroup);
  });
}

function commitOrder(container) {
  if (!container) return;
  let list;
  if (container.id === 'folder-grid') list = findItem(data, openFolderId).item?.tiles;
  else if (container.id === 'grid') list = currentGroup().tiles;
  if (!list) return;
  const ids = [...container.querySelectorAll(':scope > .tile[data-id]')].map(el => el.dataset.id);
  const byId = new Map(list.map(t => [t.id, t]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  if (next.length !== list.length) return;
  if (next.every((t, i) => t === list[i])) return;
  list.splice(0, list.length, ...next);
  save();
  if (container.id === 'folder-grid') renderGrid(false); // odśwież miniaturkę folderu
}

function mergeInto(srcId, targetId) {
  const src = findItem(data, srcId);
  const tgt = findItem(data, targetId);
  if (!src.item || !tgt.item || isFolder(src.item) || src.item === tgt.item) return;
  src.list.splice(src.list.indexOf(src.item), 1);
  if (isFolder(tgt.item)) {
    tgt.item.tiles.push(src.item);
    toast(`Dodano do folderu „${tgt.item.title}”`);
    save();
    render();
  } else {
    const f = makeFolder('Folder', [tgt.item, src.item]);
    tgt.list.splice(tgt.list.indexOf(tgt.item), 1, f);
    save();
    render();
    openFolder(f.id, true);
  }
}

/* ================= folder ================= */

function openFolder(id, editTitle = false) {
  openFolderId = id;
  renderFolder();
  openModal('#folder-modal');
  if (editTitle) { const t = $('#folder-title'); t.focus(); t.select(); }
}

function renderFolder() {
  const f = findItem(data, openFolderId).item;
  if (!isFolder(f)) { openFolderId = null; closeModals(); return; }
  const titleInp = $('#folder-title');
  if (document.activeElement !== titleInp) titleInp.value = f.title;
  const grid = $('#folder-grid');
  grid.innerHTML = '';
  f.tiles.forEach(t => grid.append(tileEl(t, f)));
  if (!RO()) grid.append(addTileEl(() => openTileModal(null, f)));
  $('#folder-open-all').disabled = !f.tiles.length;
}

/* ================= okno kafelka ================= */

let editingId = null;
let editFolderId = null;
let editImage = null;
let editImageSrc = null;
let editIcon = null;
let editIconSize = 0;

function openTileModal(t, folder) {
  editingId = t ? t.id : null;
  editFolderId = folder ? folder.id : null;
  editImage = t?.image || null;
  editImageSrc = t?.imageSrc || null;
  editIcon = t?.icon || null;
  editIconSize = t?.iconSize || 0;
  updateIconSizeUI();
  $('#tile-modal-title').textContent = t ? 'Edycja kafelka' : (folder ? `Nowy kafelek w „${folder.title}”` : 'Nowy kafelek');
  $('#f-url').value = t?.url || '';
  $('#f-title').value = t?.title || '';
  $('#f-note').value = t?.note || '';
  $('#f-watch').checked = !!t?.watch;
  $('#f-incognito').checked = !!t?.incognito;
  $('#f-emoji').value = t?.emoji || '';
  $('#f-color-auto').checked = !t?.color;
  $('#f-color').disabled = !t?.color;
  $('#f-color').value = t?.color || '#3b6fd8';
  $('#f-error').textContent = '';
  setMode(t?.image ? 'custom' : t?.preview === true ? 'shot' : t?.preview === false ? 'logo' : 'auto');
  $('#f-preview-now').hidden = !t;
  $('#f-img-url').value = t?.imageSrc || '';
  $('#f-img-fit').value = t?.imageFit || 'contain';
  $('#f-gallery-col').hidden = true;
  $('#f-gallery').innerHTML = '';
  galleryFor = null;
  $('#tile-form').querySelector('details.more-opts').open = false;

  const sel = $('#f-group');
  sel.innerHTML = '';
  const owner = t ? findItem(data, t.id).group : currentGroup();
  for (const g of data.groups) if (groupVisible(g)) sel.add(new Option(g.name, g.id, false, g === owner));
  $('#f-group-row').hidden = data.groups.length < 2 || !!folder;

  updateImagePreview();
  // okno kafelka otwiera się nad oknem folderu
  hideMenu();
  $('#tile-modal').hidden = false;
  $('#f-url').focus();
}

function updateIconPreview() {
  const p = $('#f-icon-preview');
  p.innerHTML = '';
  const url = normalizeUrl($('#f-url').value);
  if (editIcon) { const i = document.createElement('img'); i.src = editIcon; p.append(i); }
  else if (url) p.append(favImg(url));
  $('#f-icon-clear').hidden = !editIcon;
}

function updateImagePreview() {
  updateIconPreview();
  $('#f-image-clear').hidden = !editImage;
  updateTilePreview();
}

// żywy podgląd kafelka na górze okna edycji
function updateTilePreview() {
  const box = $('#f-tile-preview');
  if (!box) return;
  box.innerHTML = '';
  box.style.background = '';
  const url = normalizeUrl($('#f-url').value) || '';
  const mode = getMode();
  const classic = S().layout === 'classic';
  const color = !$('#f-color-auto').checked ? $('#f-color').value
    : classic ? '#2a2a2a' : (url ? autoColor(url) : '#4a5068');
  $('#f-tile-preview').classList.toggle('classic', classic);
  const emoji = $('#f-emoji').value.trim();
  const shot = editingId && thumbs.get(editingId);
  const note = txt => { const n = document.createElement('span'); n.className = 'tp-note'; n.textContent = txt; box.append(n); };
  if (mode === 'custom') {
    if (!editImage) { box.style.background = color; note('wybierz obraz'); }
    else if ($('#f-img-fit').value === 'cover') box.style.background = `center / cover no-repeat url("${editImage}")`;
    else { box.style.background = color; const im = new Image(); im.className = 'tp-img'; im.src = editImage; box.append(im); }
  } else if (mode === 'shot' || (mode === 'auto' && S().thumbnails && shot)) {
    if (shot) box.style.background = `top center / cover no-repeat url("${shot}")`;
    else { box.style.background = color; note('📸 brak zrzutu'); }
  } else if (emoji) {
    box.style.background = color;
    const e = document.createElement('span'); e.className = 'tp-emoji'; e.textContent = emoji; box.append(e);
  } else if (url) {
    box.style.background = color;
    const w = document.createElement('div');
    w.className = 'tp-fav';
    w.append(favImg(url, { icon: editIcon }));
    if (editIconSize) w.style.width = editIconSize * 1.2 + '%';
    box.append(w);
  } else { box.style.background = color; note('wpisz adres'); }
  $('#f-tile-preview-title').textContent = $('#f-title').value.trim() || (url ? titleFromUrl(url) : 'Nowa strona');
}

const getMode = () => document.querySelector('input[name="f-mode"]:checked')?.value || 'auto';
function setMode(m) {
  document.querySelectorAll('input[name="f-mode"]').forEach(r => r.checked = r.value === m);
  $('#f-custom-box').hidden = m !== 'custom';
  $('#f-shot-row').hidden = m !== 'shot' || !editingId;
  updateTilePreview();
}

async function loadImageFromUrl(src) {
  $('#f-error').textContent = '';
  $('#f-image-preview').textContent = 'Wczytuję…';
  let r;
  try { r = { ok: true, data: await fetchImageData(src, 640) }; }
  catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  if (!r?.ok) {
    $('#f-error').textContent = 'Nie udało się pobrać obrazu (' + (r?.error || 'błąd') + ').';
    updateImagePreview();
    return false;
  }
  editImage = r.data;
  editImageSrc = src;
  setMode('custom');
  updateImagePreview();
  return true;
}

let galleryFor = null;
async function openGallery(autoPick = false) {
  const url = normalizeUrl($('#f-url').value);
  if (!url) { $('#f-error').textContent = 'Najpierw wpisz adres strony.'; return; }
  const col = $('#f-gallery-col');
  const gal = $('#f-gallery');
  col.hidden = false;
  setMode('custom');
  if (galleryFor === url && gal.children.length && !gal.querySelector('.gal-empty')) return;
  galleryFor = url;
  gal.innerHTML = '<div class="gal-empty">Szukam logo…</div>';
  let r;
  try { r = { ok: true, list: await findSiteImages(url) }; }
  catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  if (galleryFor !== url) return;
  gal.innerHTML = '';
  const list = r?.ok ? r.list : [];
  if (!r?.ok) { gal.innerHTML = `<div class="gal-empty">⚠ Wyszukiwanie nie zadziałało: ${(r?.error || 'brak odpowiedzi').replace(/</g, '&lt;')}.<br>Sprawdź połączenie z internetem i spróbuj ponownie.</div>`; return; }
  if (!list.length) { gal.innerHTML = '<div class="gal-empty">Nie znaleziono obrazów – wklej adres obrazu albo wybierz plik.</div>'; return; }

  const loaded = [];
  for (const it of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gal-item';
    b.title = '';
    const img = document.createElement('img');
    const cap = document.createElement('small');
    b.append(img);
    loaded.push(new Promise(res => {
      img.onerror = () => { b.remove(); res(null); };
      img.onload = () => {
        if (img.naturalWidth < 24 && !it.src.startsWith('data:image/svg')) { b.remove(); return res(null); }
        b.title = it.src.startsWith('data:image/svg') ? 'SVG' : `${img.naturalWidth}×${img.naturalHeight} px`;
        res({ it, b, w: img.naturalWidth, h: img.naturalHeight });
      };
    }));
    img.src = it.src;
    b.onclick = () => pickGallery(it, b);
    gal.append(b);
  }

  if (autoPick && !editImage) {
    const res = (await Promise.race([Promise.all(loaded), new Promise(r => setTimeout(() => r(null), 6000))])) || [];
    if (galleryFor !== url || editImage) return;
    // najlepszy kandydat: logo (dane strony / SVG / obrazek) w sensownym rozmiarze, potem obraz podglądu, potem ikona
    const ok = res.filter(Boolean).filter(x => x.it.src.startsWith('data:image/svg') || x.w >= 64);
    // najpierw najwyżej oceniane logo z galerii FVD, potem logo ze strony
    const best = ok.find(x => x.it.prio === 0) || ok.find(x => x.it.prio <= 3) || ok.find(x => x.it.prio === 4) || ok[0];
    if (best) pickGallery(best.it, best.b);
  }
}

async function pickGallery(it, b) {
  const gal = $('#f-gallery');
  gal.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
  if (it.src.startsWith('data:')) {
    editImage = it.src;
    editImageSrc = null;
    $('#f-img-url').value = '';
    setMode('custom');
    updateImagePreview();
  } else {
    $('#f-img-url').value = it.src;
    await loadImageFromUrl(it.src);
  }
}

function submitTile(e) {
  e.preventDefault();
  const url = normalizeUrl($('#f-url').value);
  if (!url) { $('#f-error').textContent = 'Nieprawidłowy adres.'; return; }
  const title = $('#f-title').value.trim() || titleFromUrl(url);
  const color = $('#f-color-auto').checked ? null : $('#f-color').value;
  const emoji = $('#f-emoji').value.trim() || null;
  const groupId = $('#f-group').value || data.activeGroup;

  if (editingId) {
    const { item, list, folder } = findItem(data, editingId);
    if (!item) return closeTileModal();
    const urlChanged = item.url !== url;
    if (urlChanged) { wantIcon(url); chrome.storage.local.remove('thumb_' + item.id); }
    const mode = getMode();
    if (mode === 'custom' && !editImage) { $('#f-error').textContent = 'Wybierz obraz albo zmień tryb kafelka.'; return; }
    Object.assign(item, { url, title, color, emoji, image: mode === 'custom' ? editImage : null, icon: editIcon });
    applyNoteWatch(item);
    applyImageMeta(item, mode);
    if (editIconSize > 0) item.iconSize = editIconSize; else delete item.iconSize;
    applyPreviewChoice(item);
    if (urlChanged && item.preview === true) captureOne(item);
    const target = data.groups.find(g => g.id === groupId);
    if (!folder && target && list !== target.tiles) {
      list.splice(list.indexOf(item), 1);
      target.tiles.push(item);
    }
  } else {
    const dup = allTiles(data).find(x => urlKey(x.tile.url) === urlKey(url));
    if (dup) setTimeout(() => toast(`Uwaga: ta strona jest już w „${placeName(dup)}”`), 400);
    const t = makeTile(url, title);
    const mode = getMode();
    if (mode === 'custom' && !editImage) { $('#f-error').textContent = 'Wybierz obraz albo zmień tryb kafelka.'; return; }
    Object.assign(t, { color, emoji, image: mode === 'custom' ? editImage : null, icon: editIcon });
    applyNoteWatch(t);
    applyImageMeta(t, mode);
    if (editIconSize > 0) t.iconSize = editIconSize;
    applyPreviewChoice(t);
    if (t.preview === true) setTimeout(() => captureOne(t), 300);
    const f = editFolderId && findItem(data, editFolderId).item;
    if (isFolder(f)) f.tiles.push(t);
    else (data.groups.find(g => g.id === groupId) || currentGroup()).tiles.push(t);
  }
  save();
  render();
  closeTileModal();
}

function applyNoteWatch(item) {
  if ($('#f-incognito').checked) item.incognito = true; else delete item.incognito;
  const note = $('#f-note').value.trim();
  if (note) item.note = note.slice(0, 200); else delete item.note;
  const w = $('#f-watch').checked;
  if (w && !item.watch) { item.watch = true; setTimeout(() => chrome.runtime.sendMessage({ type: 'monitorNow' }).catch(() => {}), 500); }
  if (!w && item.watch) { delete item.watch; clearChanges(item.id); }
}

function applyPreviewChoice(item) {
  const v = getMode();
  if (v === 'shot') item.preview = true;
  else if (v === 'logo') item.preview = false;
  else delete item.preview;
}
function applyImageMeta(item, mode) {
  if (mode === 'custom') {
    item.imageFit = $('#f-img-fit').value;
    if (editImageSrc) item.imageSrc = editImageSrc; else delete item.imageSrc;
  } else { delete item.imageFit; delete item.imageSrc; }
  delete item.imageSrcFail;
}

function currentIconSize() {
  return editIconSize || S().iconSize || 0;
}
function updateIconSizeUI() {
  const v = currentIconSize();
  $('#f-isize').value = v || 42;
  $('#f-isize-val').textContent = editIconSize ? editIconSize + '%' : 'domyślna' + (S().iconSize ? ` (${S().iconSize}%)` : '');
  $('#f-isize-reset').hidden = !editIconSize;
}
// podgląd na żywo na kafelku pod oknem
function previewTileIconSize() {
  if (!editingId) return;
  document.querySelectorAll(`.tile[data-id="${CSS.escape(editingId)}"] .fav-wrap`).forEach(w => {
    if (editIconSize) applyTileIconSize(w, editIconSize);
    else { w.style.removeProperty('width'); w.style.removeProperty('max-width'); w.classList.remove('sized'); }
  });
  document.querySelectorAll(`.tile[data-id="${CSS.escape(editingId)}"] .emoji-icon`).forEach(e => {
    e.style.fontSize = editIconSize ? `calc(var(--tile-w) * ${editIconSize / 100 * 0.8})` : '';
  });
}

function closeTileModal() {
  // cofnij podgląd na żywo, jeśli anulowano
  if (editingId) setTimeout(() => { renderGrid(false); if (openFolderId) renderFolder(); }, 0);
  $('#tile-modal').hidden = true;
}

/* ================= okno nazwy ================= */

let nameSave = null;
function openNameModal({ title, value, onSave, label = 'Nazwa' }) {
  nameSave = onSave;
  $('#name-modal-title').textContent = title;
  $('#name-modal-label').textContent = label;
  $('#n-name').value = value || '';
  openModal('#name-modal');
  $('#n-name').select();
}

/* ================= PIN ================= */

let pinMode = 'set';
let pinAfter = null;
function openPinModal(mode, after) {
  pinMode = mode;
  pinAfter = after || null;
  const has = !!S().pinHash;
  $('#pin-title').textContent = mode === 'remove' ? 'Usuń PIN' : (has ? 'Zmień PIN' : 'Ustaw PIN');
  $('#pin-info').textContent = mode === 'remove'
    ? 'Wszystkie grupy zostaną odblokowane.'
    : 'PIN chroni prywatne grupy przed przypadkowym podejrzeniem. To nie jest szyfrowanie.';
  $('#pin-old-row').hidden = !has;
  $('#pin-new-row').hidden = mode === 'remove';
  $('#pin-new2-row').hidden = mode === 'remove';
  ['#pin-old', '#pin-new', '#pin-new2'].forEach(s => $(s).value = '');
  $('#pin-error').textContent = '';
  openModal('#pin-modal');
  (has ? $('#pin-old') : $('#pin-new')).focus();
}

async function submitPin(e) {
  e.preventDefault();
  const err = t => $('#pin-error').textContent = t;
  if (S().pinHash && !(await verifyPin($('#pin-old').value))) return err('Nieprawidłowy obecny PIN.');
  if (pinMode === 'remove') {
    S().pinHash = null;
    S().pinSalt = null;
    data.groups.forEach(g => g.locked = false);
    await save();
    closeModals();
    render();
    updatePinButtons();
    return toast('PIN usunięty');
  }
  const p1 = $('#pin-new').value, p2 = $('#pin-new2').value;
  if (!/^\d{4,12}$/.test(p1)) return err('PIN musi mieć od 4 do 12 cyfr.');
  if (p1 !== p2) return err('PIN-y się różnią.');
  S().pinSalt = uid() + uid();
  S().pinHash = await hashPin(p1, S().pinSalt);
  await save();
  closeModals();
  updatePinButtons();
  toast('PIN zapisany');
  if (pinAfter) pinAfter();
  render();
}

function updatePinButtons() {
  $('#s-pin-set').textContent = S().pinHash ? 'Zmień PIN' : 'Ustaw PIN';
  $('#s-pin-remove').hidden = !S().pinHash;
}

/* ================= pogoda ================= */

function wmo(code, day = 1) {
  if (code === 0) return [day ? '☀️' : '🌙', 'Bezchmurnie'];
  if (code === 1) return [day ? '🌤️' : '🌙', 'Przeważnie pogodnie'];
  if (code === 2) return ['⛅', 'Częściowe zachmurzenie'];
  if (code === 3) return ['☁️', 'Pochmurno'];
  if (code === 45 || code === 48) return ['🌫️', 'Mgła'];
  if (code >= 51 && code <= 55) return ['🌦️', 'Mżawka'];
  if (code === 56 || code === 57) return ['🌧️', 'Marznąca mżawka'];
  if (code >= 61 && code <= 65) return ['🌧️', 'Deszcz'];
  if (code === 66 || code === 67) return ['🧊', 'Marznący deszcz'];
  if (code >= 71 && code <= 77) return ['🌨️', 'Śnieg'];
  if (code >= 80 && code <= 82) return ['🌦️', 'Przelotny deszcz'];
  if (code === 85 || code === 86) return ['🌨️', 'Przelotny śnieg'];
  if (code === 95) return ['⛈️', 'Burza'];
  if (code === 96 || code === 99) return ['⛈️', 'Burza z gradem'];
  return ['🌡️', ''];
}

async function loadWeather(force = false) {
  const box = $('#weather');
  const s = S();
  if (!s.weatherOn || !s.weatherLoc) { box.hidden = true; return; }
  const loc = s.weatherLoc;
  const key = `v2:${loc.lat},${loc.lon}`;
  let cache = (await chrome.storage.local.get('weatherCache')).weatherCache;
  if (force || !cache || cache.key !== key || Date.now() - cache.at > 30 * 60 * 1000) {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m` +
        `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day&forecast_hours=12` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=4`;
      const j = await (await fetch(u)).json();
      if (!j.current) throw new Error('brak danych');
      cache = { key, at: Date.now(), j };
      await chrome.storage.local.set({ weatherCache: cache });
    } catch (e) {
      if (!cache || cache.key !== key) { box.hidden = true; return; }
    }
  }
  const { current: c, daily: d } = cache.j;
  const [icon, desc] = wmo(c.weather_code, c.is_day);
  $('#w-icon').textContent = icon;
  $('#w-temp').textContent = Math.round(c.temperature_2m) + '°';
  $('#w-city').textContent = loc.name;
  const fc = $('#w-forecast');
  fc.innerHTML = '';
  const now = document.createElement('div');
  now.className = 'now';
  now.textContent = `${desc} · odczuwalna ${Math.round(c.apparent_temperature)}° · wiatr ${Math.round(c.wind_speed_10m)} km/h`;
  const days = document.createElement('div');
  days.className = 'days';
  d.time.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'day';
    const name = i === 0 ? 'dziś' : new Date(t + 'T12:00').toLocaleDateString('pl-PL', { weekday: 'short' });
    el.innerHTML = `<b></b><span></span>${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°`;
    el.querySelector('b').textContent = name;
    el.querySelector('span').textContent = wmo(d.weather_code[i])[0];
    el.querySelector('span').title = wmo(d.weather_code[i])[1];
    days.append(el);
  });
  fc.append(now);
  const rain = rainSoon(cache.j);
  const wr = $('#w-rain');
  wr.hidden = !(rain && s.weatherRain !== false);
  if (rain) {
    wr.textContent = '☔';
    wr.title = rain.text;
    const al = document.createElement('div');
    al.className = 'rain-alert';
    al.textContent = '☔ ' + rain.text;
    fc.append(al);
  }
  const h = cache.j.hourly;
  if (h?.time?.length) {
    const hours = document.createElement('div');
    hours.className = 'hours';
    const start = Math.max(0, h.time.findLastIndex(t => t <= c.time));
    h.time.slice(start, start + 8).forEach((t, k) => {
      const i = start + k;
      const el = document.createElement('div');
      el.className = 'hour';
      el.innerHTML = '<b></b><span></span><i></i><small></small>';
      el.querySelector('b').textContent = k === 0 ? 'teraz' : t.slice(11, 13);
      const [ic, ds] = wmo(h.weather_code[i], h.is_day?.[i]);
      el.querySelector('span').textContent = ic;
      el.querySelector('span').title = ds;
      el.querySelector('i').textContent = Math.round(h.temperature_2m[i]) + '°';
      const p = h.precipitation_probability?.[i];
      el.querySelector('small').textContent = p >= 20 ? p + '%' : '';
      hours.append(el);
    });
    fc.append(hours);
  }
  fc.append(days);
  if (d.sunrise?.[0]) {
    const sun = document.createElement('div');
    sun.className = 'sun';
    sun.textContent = `🌅 wschód ${d.sunrise[0].slice(11, 16)} · 🌇 zachód ${d.sunset[0].slice(11, 16)}`;
    fc.append(sun);
  }
  box.hidden = false;
  if (!box.dataset.fit) {
    box.dataset.fit = '1';
    box.addEventListener('mouseenter', fitForecast);
    window.addEventListener('resize', fitForecast);
  }
}

// przesuń okienko prognozy tak, żeby nie wychodziło poza ekran
function fitForecast() {
  const fc = $('#w-forecast');
  fc.style.left = '0px';
  fc.style.right = 'auto';
  // pomiar od razu (okienko jest już widoczne po najechaniu myszą)
  const prev = fc.style.display;
  fc.style.visibility = 'hidden';
  fc.style.display = 'block';
  const r = fc.getBoundingClientRect();
  fc.style.display = prev;
  fc.style.visibility = '';
  if (!r.width) return;
  const m = 12;
  let shift = 0;
  if (r.right > innerWidth - m) shift = innerWidth - m - r.right;
  if (r.left + shift < m) shift = m - r.left;
  fc.style.left = shift + 'px';
}

async function findCity() {
  const q = $('#s-city').value.trim();
  const info = $('#s-city-info');
  if (!q) return;
  info.textContent = 'Szukam…';
  try {
    const j = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=pl&format=json`)).json();
    const r = j.results?.[0];
    if (!r) { info.textContent = 'Nie znaleziono takiej miejscowości.'; return; }
    S().weatherLoc = { name: r.name, lat: +r.latitude.toFixed(3), lon: +r.longitude.toFixed(3), label: [r.name, r.admin1, r.country].filter(Boolean).join(', ') };
    S().weatherOn = true;
    $('#s-weatherOn').checked = true;
    await save();
    info.textContent = '📍 ' + S().weatherLoc.label;
    loadWeather(true);
  } catch {
    info.textContent = 'Brak połączenia z serwisem pogody.';
  }
}

/* ================= ustawienia ================= */

let settingsPane = 'tiles';

const IS_OPERA = /\bOPR\//.test(navigator.userAgent);
const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
const BROWSER = IS_FIREFOX ? 'Firefox' : IS_OPERA ? 'Opera' : IS_EDGE ? 'Microsoft Edge' : 'Chrome';

function fillAbout() {
  const m = chrome.runtime.getManifest();
  $('#about-url').value = chrome.runtime.getURL('newtab.html');
  $('#about-browser').textContent = BROWSER;
  $('#s-openOnStartup').checked = S().openOnStartup ?? IS_OPERA;
  $('#opera-note').hidden = !IS_OPERA;
  $('#about-name').textContent = m.name;
  $('#about-version').textContent = 'Wersja ' + m.version;
  $('#about-author').textContent = AUTHOR;
  $('#about-copy').textContent = `© ${new Date().getFullYear()} ${AUTHOR}. Wszelkie prawa zastrzeżone.`;
}
function showPane(name) {
  settingsPane = name;
  if (name === 'trash') renderTrash();
  document.querySelectorAll('#set-nav button').forEach(b => b.classList.toggle('active', b.dataset.pane === name));
  document.querySelectorAll('.set-pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
    if (!p.hidden) $('#set-title').textContent = p.dataset.title;
  });
  $('.set-body').scrollTop = 0;
}

// kopia zapasowa zapisywana bezpośrednio ze strony (pewniejsze przy dużych plikach)
async function backupToDownloads() {
  const st = await chrome.storage.local.get(['bgImage', 'backupIds']);
  const payload = { app: 'moja-karta', version: 2, exported: new Date().toISOString(), data, bgImage: st.bgImage || null, extras: await collectExtras() };
  const json = JSON.stringify(payload);
  if (!chrome.downloads) {
    // zapasowo: zwykłe pobranie pliku (gdy Chrome nie wczytał jeszcze uprawnienia „downloads”)
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `moja-karta-${todayStr()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    await chrome.storage.local.set({ backupLast: Date.now(), backupError: null });
    setTimeout(() => toast(`ℹ Kopia zapisana w Pobranych. Kliknij ↻ przy dodatku w ${EXT_PAGE}, żeby kopie trafiały do folderu MojaKarta-kopie i działały automatycznie.`), 2600);
    return { size: json.length, fallback: true };
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const day = todayStr();
  let id;
  try {
    id = await chrome.downloads.download({ url, filename: `MojaKarta-kopie/moja-karta-${day}.json`, conflictAction: 'overwrite', saveAs: false });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(e?.message || 'Chrome nie pozwolił zapisać pliku');
  }
  if (id === undefined) { URL.revokeObjectURL(url); throw new Error(chrome.runtime.lastError?.message || 'Chrome nie rozpoczął pobierania'); }
  // poczekaj na zakończenie zapisu i sprawdź wynik
  const state = await new Promise(resolve => {
    const done = res => { chrome.downloads.onChanged.removeListener(on); clearTimeout(t); resolve(res); };
    const on = d => {
      if (d.id !== id) return;
      if (d.state?.current === 'complete') done({ ok: true });
      if (d.state?.current === 'interrupted') done({ ok: false, error: d.error?.current });
    };
    chrome.downloads.onChanged.addListener(on);
    const t = setTimeout(async () => {
      const [it] = await chrome.downloads.search({ id });
      done(it?.state === 'complete' ? { ok: true } : { ok: it?.state !== 'interrupted', error: it?.error });
    }, 30000);
    chrome.downloads.search({ id }).then(([it]) => { if (it?.state === 'complete') done({ ok: true }); });
  });
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (!state.ok) throw new Error('zapis przerwany' + (state.error ? ` (${state.error})` : ''));
  const ids = [id, ...(st.backupIds || []).filter(x => x !== id)];
  for (const old of ids.slice(8)) {
    try { await chrome.downloads.removeFile(old); } catch {}
    try { await chrome.downloads.erase({ id: old }); } catch {}
  }
  await chrome.storage.local.set({ backupLast: Date.now(), backupIds: ids.slice(0, 8), backupError: null });
  return { id, size: json.length };
}

async function runMonitorNow() {
  $('#s-monitor-info').textContent = 'Sprawdzam strony…';
  const r = await chrome.runtime.sendMessage({ type: 'monitorNow' }).catch(() => null);
  if (r?.busy) $('#s-monitor-info').textContent = 'Sprawdzanie już trwa…';
  else if (r?.checked != null) toast(r.down ? `⚠ Nie odpowiada: ${r.down} z ${r.checked} stron` : `✓ Wszystkie strony działają (${r.checked})`);
  showMonitorInfo();
}
async function showMonitorInfo() {
  const { monitorLast } = await chrome.storage.local.get('monitorLast');
  const down = Object.values(health).filter(h => !h.ok).length;
  $('#s-monitor-info').textContent = monitorLast
    ? `Ostatnio: ${new Date(monitorLast).toLocaleString('pl-PL')}${S().monitorOn ? ` · nie działa: ${down}` : ''}`
    : 'Jeszcze nie sprawdzano.';
}
async function showBackupInfo() {
  const { backupLast, backupError } = await chrome.storage.local.get(['backupLast', 'backupError']);
  if (backupError) { $('#s-backup-info').textContent = '⚠ Ostatnia automatyczna kopia nie udała się: ' + backupError; return; }
  $('#s-backup-info').textContent = backupLast
    ? `Ostatnia kopia: ${new Date(backupLast).toLocaleString('pl-PL')} · folder Pobrane → MojaKarta-kopie (8 ostatnich)`
    : 'Jeszcze nie zrobiono kopii.';
}

async function renderTrash() {
  const box = $('#trash-list');
  const t = await getTrash();
  box.innerHTML = '';
  $('#trash-empty').hidden = !t.length;
  if (!t.length) { box.innerHTML = '<div class="set-row"><div class="set-desc">Kosz jest pusty.</div></div>'; return; }
  for (const e of t) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const txt = document.createElement('div');
    txt.className = 'set-text';
    const name = document.createElement('div');
    name.className = 'set-name';
    const desc = document.createElement('div');
    desc.className = 'set-desc';
    const days = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - e.deletedAt) / 864e5));
    if (e.kind === 'group') {
      name.textContent = '📂 Grupa „' + e.group.name + '”';
      desc.textContent = `${e.group.tiles.length} elementów · usunięta ${new Date(e.deletedAt).toLocaleString('pl-PL')} · zostało ${days} dni`;
    } else {
      name.textContent = (e.kind === 'folder' ? '📁 ' : '') + e.item.title;
      desc.textContent = `z grupy „${e.groupName || '?'}” · ${e.kind === 'tile' ? hostOf(e.item.url) + ' · ' : ''}zostało ${days} dni`;
    }
    txt.append(name, desc);
    const ctl = document.createElement('div');
    ctl.className = 'set-ctl';
    const rb = document.createElement('button');
    rb.type = 'button'; rb.className = 'btn small-btn'; rb.textContent = 'Przywróć';
    rb.onclick = async () => { const what = restoreEntry(e); await removeFromTrash(e.id); await save(); render(); renderTrash(); toast('Przywrócono ' + what); };
    const db = document.createElement('button');
    db.type = 'button'; db.className = 'btn ghost small-btn'; db.textContent = '✕'; db.title = 'Usuń na zawsze';
    db.onclick = async () => { await removeFromTrash(e.id); renderTrash(); };
    ctl.append(rb, db);
    row.append(txt, ctl);
    box.append(row);
  }
}

/* ---------- duplikaty ---------- */
function findDuplicates() {
  const map = new Map();
  for (const x of allTiles(data)) {
    const k = urlKey(x.tile.url);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.values()].filter(v => v.length > 1);
}
function placeName(x) {
  return x.group.name + (x.folder ? ' › ' + x.folder.title : '');
}
function openDuplicates() {
  const sets = findDuplicates();
  const box = $('#dup-list');
  box.innerHTML = '';
  $('#dup-all').hidden = !sets.length;
  $('#dup-info').textContent = sets.length
    ? `Znaleziono ${sets.length} ${sets.length === 1 ? 'stronę' : 'stron'} w kilku miejscach. Przy usuwaniu zostaje pierwszy kafelek, reszta trafia do kosza.`
    : '✓ Brak duplikatów.';
  sets.forEach((set, i) => {
    const card = document.createElement('div');
    card.className = 'dup-set';
    const head = document.createElement('div');
    head.className = 'dup-head';
    const img = favImg(set[0].tile.url);
    img.className = 'dup-fav';
    const t = document.createElement('b');
    t.textContent = set[0].tile.title;
    const u = document.createElement('span');
    u.className = 'hint';
    u.textContent = hostOf(set[0].tile.url);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn small-btn'; btn.textContent = 'Zostaw pierwszy';
    btn.onclick = () => removeDuplicates(i);
    head.append(img, t, u, btn);
    const places = document.createElement('div');
    places.className = 'dup-places';
    set.forEach((x, j) => {
      const p = document.createElement('span');
      p.className = 'dup-place' + (j === 0 ? ' keep' : '');
      p.textContent = (j === 0 ? '✓ ' : '') + placeName(x) + (x.tile.title !== set[0].tile.title ? ` („${x.tile.title}”)` : '');
      places.append(p);
    });
    card.append(head, places);
    box.append(card);
  });
  openModal('#dup-modal');
}
async function removeDuplicates(index) {
  const sets = findDuplicates();
  const chosen = index === null ? sets : [sets[index]].filter(Boolean);
  let n = 0;
  for (const set of chosen) {
    for (const x of set.slice(1)) {
      const f = findItem(data, x.tile.id);
      if (!f.item) continue;
      f.list.splice(f.list.indexOf(f.item), 1);
      await addToTrash({ kind: 'tile', item: f.item, groupId: f.group.id, groupName: f.group.name, folderId: f.folder?.id });
      n++;
    }
  }
  cleanupFolders();
  await save();
  render();
  toast(`Przeniesiono do kosza ${n} duplikat${n === 1 ? '' : 'ów'}`);
  openDuplicates();
}

function openSettings(pane) {
  const s = S();
  showPane(typeof pane === 'string' ? pane : settingsPane);
  $('#s-columns').value = s.columns;
  $('#s-columns-val').textContent = s.columns;
  $('#s-tileSize').value = s.tileSize;
  $('#s-tileStyle').value = s.tileStyle;
  $('#s-iconStyle').value = s.iconStyle;
  $('#s-frame').value = s.frame || 'normal';
  $('#s-tileHover').value = s.tileHover || 'lift';
  $('#s-weatherRain').checked = s.weatherRain !== false;
  $('#s-showPad').checked = s.showPad !== false;
  $('#s-ratesOn').checked = !!s.ratesOn;
  $('#s-countdownOn').checked = s.countdownOn !== false;
  renderRatePicks();
  renderCdList();
  $('#s-tileBgAlpha').value = s.tileBgAlpha ?? 0;
  $('#s-tileBgAlpha-val').textContent = (s.tileBgAlpha ?? 0) + '%';
  $('#s-iconSize').value = s.iconSize || 42;
  $('#s-iconSize-val').textContent = s.iconSize ? s.iconSize + '%' : 'auto';
  $('#s-showTitles').checked = s.showTitles;
  $('#s-showAddTile').checked = s.showAddTile;
  $('#s-showRecent').checked = s.showRecent;
  $('#s-showNotes').checked = s.showNotes;
  $('#s-readOnly').checked = !!s.readOnly;
  $('#s-rssOn').checked = s.rssOn;
  $('#s-rssMax').value = String(s.rssMax || 50);
  renderFeedList();
  $('#s-monitorOn').checked = s.monitorOn;
  $('#s-monitorEvery').value = String(s.monitorEvery || 60);
  $('#s-watchNotify').checked = s.watchNotify;
  $('#s-backupMode').value = s.backupMode || 'weekly';
  showMonitorInfo();
  showBackupInfo();
  $('#s-openInNewTab').checked = s.openInNewTab;
  $('#s-thumbnails').checked = s.thumbnails;
  $('#s-badges').checked = s.badges;
  $('#s-theme').value = s.theme;
  renderThemes();
  $('#s-titleFont').value = s.titleFont || 'system';
  $('#s-titleSize').value = s.titleSize || 13;
  $('#s-titleSize-val').textContent = (s.titleSize || 13) + ' px';
  $('#s-titleBold').checked = !!s.titleBold;
  $('#s-titleColorAuto').checked = !s.titleColor;
  $('#s-titleColor').value = s.titleColor || '#ffffff';
  $('#s-titleColor').disabled = !s.titleColor;
  $('#s-rotateMode').value = s.rotateMode || 'day';
  $('#s-fx').value = s.fx || 'off';
  $('#s-fxAmount').value = String(s.fxAmount || 2);
  renderRotateList();
  $('#s-layout').value = s.layout;
  $('#s-showClock').checked = s.showClock;
  $('#s-showSearch').checked = s.showSearch;
  $('#s-engine').value = s.engine;
  $('#s-bgType').value = s.bgType;
  $('#s-bgColor').value = s.bgColor;
  $('#s-bgDim').value = s.bgDim;
  $('#s-bgDim-val').textContent = s.bgDim + '%';
  $('#s-weatherOn').checked = s.weatherOn;
  $('#s-city').value = s.weatherLoc?.name || '';
  $('#s-city-info').textContent = s.weatherLoc ? '📍 ' + (s.weatherLoc.label || s.weatherLoc.name) : 'Nie ustawiono';
  $('#s-sync').checked = s.sync;
  updateIconPermUI();
  fillAbout();
  showSyncInfo();
  updatePinButtons();
  renderSwatches();
  updateBgOpts();
  openModal('#settings-modal');
}

async function showSyncInfo() {
  const el = $('#s-sync-info');
  if (!S().sync) {
    el.textContent = 'Kafelki, grupy i ustawienia będą takie same na każdym komputerze, na którym jesteś zalogowany w Chrome. Własne obrazki i tło z pliku zostają lokalnie (limit Chrome).';
    return;
  }
  const st = (await chrome.storage.local.get('syncStatus')).syncStatus;
  if (!st) el.textContent = 'Synchronizacja włączona.';
  else if (st.ok) el.textContent = `Zsynchronizowano: ${new Date(st.at).toLocaleString('pl-PL')} · ${Math.round(st.size / 1024)} KB z ~95 KB`;
  else el.textContent = `⚠ Błąd synchronizacji: ${st.error}`;
}

function renderSwatches() {
  const box = $('#bg-gradient-opts');
  box.innerHTML = '';
  GRADIENTS.forEach((gr, i) => {
    const d = document.createElement('div');
    d.className = 'swatch' + (i === S().bgGradient ? ' active' : '');
    d.style.background = gr;
    d.onclick = () => { setSetting('bgGradient', i); renderSwatches(); };
    box.append(d);
  });
}

/* ---------- ustawianie kadru tła ---------- */
let cropStart = null;
function startCrop() {
  const e = effectiveBg();
  if (!PHOTO_BG.includes(e.type)) return toast('Kadr ustawisz dla zdjęcia, tapety dnia, desek lub zmieniających się zdjęć');
  closeModals();
  cropStart = { ...(e.pos || { x: 50, y: 50, z: 100 }) };
  cropDraft = { ...cropStart };
  document.body.classList.add('cropping');
  $('#crop-layer').hidden = false;
  $('#crop-who').textContent = e.owner ? `tło grupy „${e.owner.name}”` : 'tło strony';
  updateCropInfo();
}
function updateCropInfo() {
  $('#crop-zoom').textContent = cropDraft.z + '%';
  applyCrop(cropDraft, effectiveBg().type);
}
function endCrop(saveIt) {
  if (!cropDraft) { $('#crop-layer').hidden = true; document.body.classList.remove('cropping'); return; }
  const e = effectiveBg();
  if (saveIt) {
    const p = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), z: cropDraft.z };
    if (e.owner) e.owner.bg.pos = p; else S().bgPos = p;
    save();
    toast('Zapisano kadr tła');
  }
  cropDraft = null;
  document.body.classList.remove('cropping');
  $('#crop-layer').hidden = true;
  applyBackground();
}
function bindCrop() {
  const layer = $('#crop-layer');
  let drag = null;
  layer.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.crop-bar')) return;
    drag = { x: ev.clientX, y: ev.clientY, px: cropDraft.x, py: cropDraft.y };
    layer.setPointerCapture(ev.pointerId);
    layer.classList.add('grabbing');
  });
  layer.addEventListener('pointermove', ev => {
    if (!drag) return;
    // przesunięcie myszą w prawo przesuwa zdjęcie w prawo (pokazuje jego lewą część)
    const k = 120 / (cropDraft.z / 100);
    cropDraft.x = Math.min(100, Math.max(0, drag.px - (ev.clientX - drag.x) / innerWidth * k));
    cropDraft.y = Math.min(100, Math.max(0, drag.py - (ev.clientY - drag.y) / innerHeight * k));
    updateCropInfo();
  });
  const stop = () => { drag = null; layer.classList.remove('grabbing'); };
  layer.addEventListener('pointerup', stop);
  layer.addEventListener('pointercancel', stop);
  layer.addEventListener('wheel', ev => {
    ev.preventDefault();
    cropDraft.z = Math.min(250, Math.max(100, cropDraft.z + (ev.deltaY < 0 ? 5 : -5)));
    updateCropInfo();
  }, { passive: false });
  $('#crop-plus').onclick = () => { cropDraft.z = Math.min(250, cropDraft.z + 10); updateCropInfo(); };
  $('#crop-minus').onclick = () => { cropDraft.z = Math.max(100, cropDraft.z - 10); updateCropInfo(); };
  $('#crop-reset').onclick = () => { cropDraft = { x: 50, y: 50, z: 100 }; updateCropInfo(); };
  $('#crop-ok').onclick = () => endCrop(true);
  $('#crop-cancel').onclick = () => endCrop(false);
  document.addEventListener('keydown', ev => {
    if (layer.hidden) return;
    if (ev.key === 'Enter') { ev.preventDefault(); endCrop(true); }
    if (ev.key === 'Escape') { ev.stopImmediatePropagation(); endCrop(false); }
  }, true);
}

function renderRotateList() {
  const box = $('#rotate-list');
  if (!box) return;
  box.innerHTML = '';
  rotateImages.forEach((src, i) => {
    const d = document.createElement('div');
    d.className = 'rot-item';
    d.style.backgroundImage = `url("${src}")`;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.title = 'Usuń z rotacji';
    x.onclick = async () => {
      rotateImages.splice(i, 1);
      await chrome.storage.local.set({ bgRotate: rotateImages });
      renderRotateList();
      applyBackground();
    };
    d.append(x);
    box.append(d);
  });
  $('#rotate-count').textContent = rotateImages.length ? `${rotateImages.length} zdjęć` : 'Brak zdjęć – dodaj kilka.';
}

function updateBgOpts() {
  const t = S().bgType;
  $('#bg-rotate-opts').hidden = t !== 'rotate';
  $('#bg-gradient-row').hidden = t !== 'gradient';
  $('#bg-color-opts').hidden = t !== 'color';
  $('#bg-image-opts').hidden = t !== 'image';
  $('#bg-dim-row').hidden = !['image', 'bing', 'wood', 'rotate'].includes(t);
  $('#bg-crop-row').hidden = !PHOTO_BG.includes(t);
}

function applyLayout(layout) {
  const s = S();
  s.layout = layout;
  if (layout === 'classic') {
    Object.assign(s, { showClock: false, showTitles: true, columns: 9, tileSize: 'm', iconStyle: 'clear', frame: 'normal', tileBgAlpha: 0 });
    if (s.bgType === 'gradient') s.bgType = 'wood';
  } else {
    Object.assign(s, { showClock: true, columns: 6, frame: 'none' });
    if (s.bgType === 'wood') s.bgType = 'gradient';
  }
  applySettings();
  save();
  render();
  openSettings('look');
  if (layout === 'classic' && !s.thumbnails && confirm('W układzie klasycznym kafelki pokazują podgląd strony.\n\nWłączyć podglądy i utworzyć je teraz dla wszystkich stron? (na chwilę otworzy się osobne okno)')) {
    startCaptureAll();
    render();
  }
}

function setSetting(key, value) {
  S()[key] = value;
  applySettings();
  save();
}

function startCaptureAll() {
  if (!S().thumbnails) { S().thumbnails = true; $('#s-thumbnails').checked = true; applySettings(); save(); }
  chrome.runtime.sendMessage({ type: 'captureAll' }).catch(() => {});
}

function showCaptureProgress(p) {
  const el = $('#s-capture-status');
  const btn = $('#s-capture-all');
  if (p) {
    el.textContent = `Robię podglądy: ${p.done + 1} / ${p.total} – ${p.title}`;
    btn.textContent = 'Przerwij';
    btn.dataset.running = '1';
    toastPersistent(`📸 Podglądy: ${p.done + 1} / ${p.total}`);
  } else {
    el.textContent = 'Strony otworzą się kolejno w osobnym oknie, które zamknie się samo.';
    btn.textContent = 'Utwórz teraz';
    delete btn.dataset.running;
    if (btn.dataset.wasRunning) { toast('Podglądy gotowe ✓'); }
  }
  btn.dataset.wasRunning = p ? '1' : '';
}

async function updateIconPermUI() {
  let ok = false;
  try { ok = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch {}
  $('#s-icons-allow').hidden = ok;
  $('#s-icons-ok').hidden = !ok;
  const hosts = [...new Set(allTiles(data).map(({ tile }) => hostOf(tile.url)))];
  const recs = hosts.map(h => icons.get(h)).filter(Boolean);
  const hd = recs.filter(r => r.img && (r.svg || r.w >= 96)).length;
  $('#s-icons-stat').textContent = `Ikony w wysokiej jakości: ${hd} z ${hosts.length} stron` + (recs.length < hosts.length ? ` (pobieranie: ${hosts.length - recs.length})` : '');
}

async function refreshAllIcons() {
  const keys = [...new Set(allTiles(data).map(({ tile }) => 'icon_' + hostOf(tile.url)))];
  await chrome.storage.local.remove(keys);
  icons.clear();
  allTiles(data).forEach(({ tile }) => { if (!tile.icon) wantIcon(tile.url, true); });
  render();
  toast('Pobieram ikony od nowa…');
}

async function requestSites() {
  try { return await chrome.permissions.request({ origins: ['<all_urls>'] }); }
  catch { return false; }
}

function bindSettings() {
  document.querySelectorAll('#set-nav button').forEach(b => b.onclick = () => showPane(b.dataset.pane));
  $('#settings-modal').addEventListener('keydown', e => {
    if (!e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('#set-nav')) {
      e.preventDefault();
      const btns = [...document.querySelectorAll('#set-nav button')];
      const i = btns.findIndex(b => b.dataset.pane === settingsPane);
      const n = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      showPane(n.dataset.pane); n.focus();
    }
  });
  const sel = $('#s-engine');
  for (const [k, v] of Object.entries(ENGINES)) sel.add(new Option(k === 'chrome' ? `Domyślna wyszukiwarka (${BROWSER})` : v.name, k));

  $('#s-columns').oninput = e => {
    $('#s-columns-val').textContent = e.target.value;
    setSetting('columns', +e.target.value);
  };
  $('#s-tileSize').onchange = e => setSetting('tileSize', e.target.value);
  $('#s-tileStyle').onchange = e => setSetting('tileStyle', e.target.value);
  $('#s-iconStyle').onchange = e => setSetting('iconStyle', e.target.value);
  $('#s-frame').onchange = e => setSetting('frame', e.target.value);
  $('#s-tileHover').onchange = e => setSetting('tileHover', e.target.value);
  $('#s-weatherRain').onchange = e => { setSetting('weatherRain', e.target.checked); loadWeather(); };
  $('#s-showPad').onchange = e => { setSetting('showPad', e.target.checked); if (!e.target.checked) togglePad(false); };
  $('#s-ratesOn').onchange = e => { setSetting('ratesOn', e.target.checked); loadRates(); };
  $('#s-countdownOn').onchange = e => { setSetting('countdownOn', e.target.checked); renderCountdowns(); };
  $('#cd-add').onsubmit = e => {
    e.preventDefault();
    const name = $('#cd-name').value.trim(), date = $('#cd-date').value;
    if (!name || !date) return;
    S().countdowns = [...(S().countdowns || []), { id: uid(), name, date, yearly: $('#cd-yearly').checked }];
    save();
    $('#cd-name').value = ''; $('#cd-date').value = ''; $('#cd-yearly').checked = false;
    renderCdList(); renderCountdowns();
  };
  bindTilt();
  $('#s-tileBgAlpha').oninput = e => {
    $('#s-tileBgAlpha-val').textContent = e.target.value + '%';
    setSetting('tileBgAlpha', +e.target.value);
  };
  $('#s-iconSize').oninput = e => {
    $('#s-iconSize-val').textContent = e.target.value + '%';
    setSetting('iconSize', +e.target.value);
  };
  $('#s-iconSize-reset').onclick = () => {
    setSetting('iconSize', 0);
    $('#s-iconSize').value = 42;
    $('#s-iconSize-val').textContent = 'auto';
  };
  $('#s-showTitles').onchange = e => setSetting('showTitles', e.target.checked);
  $('#s-showAddTile').onchange = e => { setSetting('showAddTile', e.target.checked); renderGrid(false); };
  $('#s-readOnly').onchange = e => setReadOnly(e.target.checked);
  $('#s-openOnStartup').onchange = e => setSetting('openOnStartup', e.target.checked);
  $('#about-copy-url').onclick = () => navigator.clipboard.writeText($('#about-url').value).then(() => toast('Skopiowano adres – wklej go jako stronę startową'));
  $('#s-rssOn').onchange = e => { setSetting('rssOn', e.target.checked); refreshNews(false); };
  $('#s-rssMax').onchange = e => { setSetting('rssMax', +e.target.value); refreshNews(false); };
  $('#rss-add').onclick = () => addFeed($('#rss-url').value);
  $('#rss-url').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addFeed(e.target.value); } };
  $('#rss-detect').onclick = detectFeedsFromTiles;
  $('#s-showNotes').onchange = e => { setSetting('showNotes', e.target.checked); render(); };
  $('#s-monitorOn').onchange = e => {
    setSetting('monitorOn', e.target.checked);
    if (e.target.checked) { runMonitorNow(); } else { health = {}; chrome.storage.local.set({ health: {} }); render(); }
  };
  $('#s-monitorEvery').onchange = e => { setSetting('monitorEvery', +e.target.value); chrome.runtime.sendMessage({ type: 'monitorConfig' }).catch(() => {}); };
  $('#s-watchNotify').onchange = e => setSetting('watchNotify', e.target.checked);
  $('#s-monitorNow').onclick = runMonitorNow;
  $('#s-backupMode').onchange = e => setSetting('backupMode', e.target.value);
  $('#s-backupNow').onclick = async () => {
    const btn = $('#s-backupNow');
    btn.disabled = true;
    $('#s-backup-info').textContent = 'Zapisuję kopię…';
    try {
      const r = await backupToDownloads();
      if (!r.fallback) toast(`💾 Kopia zapisana (${(r.size / 1048576).toFixed(1)} MB) – Pobrane → MojaKarta-kopie`);
      else toast(`💾 Kopia zapisana (${(r.size / 1048576).toFixed(1)} MB) w folderze Pobrane`);
    } catch (e) {
      const msg = String(e?.message || e || 'nieznany błąd');
      $('#s-backup-info').textContent = '⚠ ' + msg;
      toast('Nie udało się zapisać kopii: ' + msg);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    showBackupInfo();
  };
  $('#s-restore').onclick = () => $('#s-import-file').click();
  $('#s-backupShow').onclick = async () => {
    const { backupIds } = await chrome.storage.local.get('backupIds');
    if (backupIds?.[0]) chrome.downloads.show(backupIds[0]); else toast('Nie ma jeszcze żadnej kopii');
  };
  $('#s-showRecent').onchange = e => { setSetting('showRecent', e.target.checked); if (!e.target.checked) viewRecent = false; render(); };
  $('#s-dups').onclick = openDuplicates;
  $('#dup-all').onclick = () => removeDuplicates(null);
  $('#trash-empty').onclick = async () => {
    if (!confirm('Opróżnić kosz? Tego nie da się cofnąć.')) return;
    await chrome.storage.local.set({ trash: [] });
    renderTrash();
  };
  $('#s-openInNewTab').onchange = e => { setSetting('openInNewTab', e.target.checked); render(); };

  $('#s-thumbnails').onchange = async e => {
    if (e.target.checked && !(await requestSites())) {
      e.target.checked = false;
      return toast('Bez zgody Chrome podglądy nie mogą działać');
    }
    setSetting('thumbnails', e.target.checked);
    render();
    if (e.target.checked && confirm('Utworzyć teraz podglądy wszystkich stron?\n\nNa chwilę otworzy się osobne okno, które samo przejdzie przez Twoje strony i się zamknie.')) startCaptureAll();
  };
  $('#s-badges').onchange = async e => {
    if (e.target.checked && !(await requestSites())) toast('Bez zgody działa tylko licznik Gmaila');
    setSetting('badges', e.target.checked);
    if (e.target.checked) chrome.runtime.sendMessage({ type: 'refreshBadges' }).catch(() => {});
    render();
  };

  $('#s-icons-allow').onclick = async () => {
    if (await requestSites()) { await updateIconPermUI(); refreshAllIcons(); }
    else toast('Bez zgody ikony będą pobierane tylko z serwisu Google');
  };
  $('#s-icons-refresh').onclick = refreshAllIcons;
  $('#s-capture-all').onclick = e => {
    if (e.target.dataset.running) chrome.runtime.sendMessage({ type: 'captureCancel' }).catch(() => {});
    else startCaptureAll();
  };
  $('#s-theme').onchange = e => setSetting('theme', e.target.value);
  $('#s-titleFont').onchange = e => setSetting('titleFont', e.target.value);
  $('#s-titleSize').oninput = e => { $('#s-titleSize-val').textContent = e.target.value + ' px'; setSetting('titleSize', +e.target.value); };
  $('#s-titleBold').onchange = e => setSetting('titleBold', e.target.checked);
  $('#s-titleColorAuto').onchange = e => { $('#s-titleColor').disabled = e.target.checked; setSetting('titleColor', e.target.checked ? null : $('#s-titleColor').value); };
  $('#s-titleColor').oninput = e => setSetting('titleColor', e.target.value);
  $('#s-fx').onchange = e => setSetting('fx', e.target.value);
  $('#s-fxAmount').onchange = e => setSetting('fxAmount', +e.target.value);
  $('#s-crop').onclick = startCrop;
  $('#s-crop-reset').onclick = () => { S().bgPos = null; save(); applyBackground(); toast('Kadr przywrócony do środka'); };
  $('#s-rotateMode').onchange = e => { rotateOpenIdx = null; setSetting('rotateMode', e.target.value); };
  $('#s-rotate-add').onclick = () => $('#s-rotate-file').click();
  $('#s-rotate-file').onchange = async e => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try { rotateImages.push(await resizeImage(f, 2560, 0.85)); } catch {}
    }
    await chrome.storage.local.set({ bgRotate: rotateImages });
    renderRotateList();
    if (S().bgType !== 'rotate') { setSetting('bgType', 'rotate'); $('#s-bgType').value = 'rotate'; updateBgOpts(); }
    else applyBackground();
    toast(`Zdjęć w rotacji: ${rotateImages.length}`);
  };
  $('#gc-none').onclick = () => setGroupColor(null);
  $('#gc-apply').onclick = () => setGroupColor($('#gc-custom').value);
  document.querySelectorAll('#gbg-modal [data-bg]').forEach(b => b.onclick = async () => {
    const t = b.dataset.bg;
    if (t === 'inherit') return setGroupBg(null);
    if (t === 'crop') { closeModals(); if (bgTarget && bgTarget.id !== data.activeGroup) switchGroup(bgTarget.id); return startCrop(); }
    if (t === 'image') return $('#gb-file').click();
    if (t === 'color') return setGroupBg({ type: 'color', v: $('#gb-color').value });
    setGroupBg({ type: t });
  });
  $('#gb-file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !bgTarget) return;
    try {
      const img = await resizeImage(f, 2560, 0.85);
      await chrome.storage.local.set({ ['gbg_' + bgTarget.id]: img });
      groupBgImages.set(bgTarget.id, img);
      setGroupBg({ type: 'image' });
    } catch { toast('Nie udało się wczytać zdjęcia'); }
  };
  $('#s-layout').onchange = e => applyLayout(e.target.value);
  $('#s-showClock').onchange = e => setSetting('showClock', e.target.checked);
  $('#s-showSearch').onchange = e => setSetting('showSearch', e.target.checked);
  $('#s-engine').onchange = e => setSetting('engine', e.target.value);
  $('#s-bgType').onchange = e => {
    setSetting('bgType', e.target.value);
    updateBgOpts();
    if (e.target.value === 'image' && !bgImage) $('#s-bgImage-file').click();
  };
  $('#s-bgColor').oninput = e => setSetting('bgColor', e.target.value);
  $('#s-bgDim').oninput = e => {
    $('#s-bgDim-val').textContent = e.target.value + '%';
    S().bgDim = +e.target.value;
    $('#bg-dim').style.opacity = S().bgDim / 100;
    save();
  };
  $('#s-bgImage-pick').onclick = () => $('#s-bgImage-file').click();
  $('#s-bgImage-file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      bgImage = await resizeImage(f, 2560, 0.85);
      await chrome.storage.local.set({ bgImage });
      setSetting('bgType', 'image');
      $('#s-bgType').value = 'image';
      updateBgOpts();
    } catch { toast('Nie udało się wczytać obrazu'); }
  };

  $('#s-weatherOn').onchange = e => {
    S().weatherOn = e.target.checked;
    save();
    if (e.target.checked && !S().weatherLoc) { $('#s-city').focus(); $('#s-city-info').textContent = 'Wpisz miasto i kliknij „Ustaw”.'; }
    loadWeather();
  };
  $('#s-city-find').onclick = findCity;
  $('#s-city').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); findCity(); } };

  $('#s-sync').onchange = async e => {
    if (e.target.checked) {
      try {
        const remote = await pullSync();
        if (remote) {
          const n = allTiles(remote).length;
          const useRemote = confirm(`Na Twoim koncie Google są już kafelki z innego komputera (${n} stron, ${remote.groups.length} grup).\n\nOK – użyj ich na tym komputerze\nAnuluj – zastąp je kafelkami z tego komputera`);
          if (useRemote) {
            data = mergeRemote(remote, data);
            await saveLocalOnly(data);
            applySettings();
            render();
            toast('Pobrano kafelki z konta Google');
            showSyncInfo();
            return;
          }
        }
        S().sync = true;
        await saveData(data, { syncNow: true });
        toast('Synchronizacja włączona');
      } catch (err) {
        e.target.checked = false;
        S().sync = false;
        save();
        toast('Nie udało się włączyć synchronizacji: ' + (err.message || err));
      }
    } else {
      S().sync = false;
      save();
    }
    showSyncInfo();
  };

  $('#s-pin-set').onclick = () => openPinModal('set');
  $('#s-pin-remove').onclick = () => openPinModal('remove');

  $('#s-bookmarks').onclick = openBookmarks;
  $('#s-export').onclick = exportData;
  $('#s-import').onclick = () => $('#s-import-file').click();
  $('#s-import-file').onchange = importData;
  $('#s-reset').onclick = async () => {
    if (!confirm('Przywrócić ustawienia domyślne? Wszystkie kafelki i grupy zostaną usunięte.')) return;
    const keepSync = S().sync;
    data = defaultData();
    data.settings.sync = keepSync;
    bgImage = null;
    await chrome.storage.local.remove('bgImage');
    await save();
    applySettings();
    render();
    closeModals();
    toast('Przywrócono ustawienia domyślne');
  };
}

/* ================= import zakładek ================= */

let bmSelected = null;

async function openBookmarks() {
  let ok = false;
  try { ok = await chrome.permissions.request({ permissions: ['bookmarks'] }); } catch {}
  if (!ok || !chrome.bookmarks) return toast('Bez zgody Chrome nie można odczytać zakładek');
  const tree = await chrome.bookmarks.getTree();
  const box = $('#bm-tree');
  box.innerHTML = '';
  bmSelected = null;
  $('#bm-import').disabled = true;

  const count = n => (n.children || []).reduce((s, c) => s + (c.url ? 1 : count(c)), 0);
  const walk = (node, depth) => {
    for (const c of node.children || []) {
      if (c.url) continue;
      const n = count(c);
      const b = document.createElement('button');
      b.type = 'button';
      b.style.paddingLeft = (8 + depth * 18) + 'px';
      b.innerHTML = '<span>📁</span><span class="nm"></span><span class="cnt"></span>';
      b.querySelector('.nm').textContent = c.title || '(bez nazwy)';
      b.querySelector('.cnt').textContent = n;
      b.onclick = () => {
        box.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        bmSelected = c;
        $('#bm-import').disabled = n === 0;
      };
      box.append(b);
      walk(c, depth + 1);
    }
  };
  walk(tree[0], 0);
  openModal('#bm-modal');
}

function importBookmarks() {
  if (!bmSelected) return;
  const links = n => (n.children || []).flatMap(c => c.url ? [c] : links(c));
  const items = [];
  for (const c of bmSelected.children || []) {
    if (c.url) {
      if (isAddableUrl(c.url)) items.push(makeTile(c.url, c.title || titleFromUrl(c.url)));
    } else {
      const tiles = links(c).filter(x => isAddableUrl(x.url)).map(x => makeTile(x.url, x.title || titleFromUrl(x.url)));
      if (tiles.length) items.push(makeFolder(c.title || 'Folder', tiles));
    }
  }
  if (!items.length) return toast('Ten folder nie zawiera stron');
  const asNew = document.querySelector('input[name="bm-target"]:checked').value === 'new';
  if (asNew) {
    const g = { id: uid(), name: bmSelected.title || 'Zakładki', locked: false, tiles: items };
    data.groups.push(g);
    data.activeGroup = g.id;
  } else {
    currentGroup().tiles.push(...items);
  }
  save();
  closeModals();
  render();
  renderGrid(true);
  const n = items.reduce((s, it) => s + (isFolder(it) ? it.tiles.length : 1), 0);
  toast(`Zaimportowano ${n} stron`);
}

/* ================= kopia zapasowa ================= */

async function exportData() {
  const extras = await collectExtras();
  const payload = { app: 'moja-karta', version: 2, exported: new Date().toISOString(), data, bgImage, extras };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moja-karta-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importData(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    const nd = normalizeData(structuredClone(json.data || json));
    if (!nd) throw new Error();
    const count = allTiles(nd).length;
    const ex = json.extras ? Object.keys(json.extras) : [];
    const shots = ex.filter(k => k.startsWith('thumb_')).length;
    const more = json.extras ? `\n\nRazem z: ${shots} podglądami stron, tłami grup, zdjęciami tła i ikonami.` : '';
    if (!confirm(`Przywrócić kopię z ${json.exported ? new Date(json.exported).toLocaleString('pl-PL') : 'pliku'}?\n\n${nd.groups.length} grup(y), ${count} stron i wszystkie ustawienia.${more}\n\nObecne dane zostaną zastąpione.`)) return;
    nd.settings.sync = S().sync;
    data = nd;
    if (json.bgImage) { bgImage = json.bgImage; await chrome.storage.local.set({ bgImage }); }
    if (json.extras) await restoreExtras(json.extras);
    await save();
    toast('Przywrócono kopię – odświeżam…');
    setTimeout(() => location.reload(), 700);
  } catch {
    toast('To nie jest prawidłowy plik kopii Mojej Karty');
  }
}

/* ================= pomocnicze ================= */

// ikona: kwadrat 256 px, z zachowaniem przezroczystości; SVG bez zmian
function resizeIcon(file) {
  if (file.type === 'image/svg+xml' && file.size < 300000) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = Math.min(256, Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const k = S / Math.max(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (S - img.width * k) / 2, (S - img.height * k) / 2, img.width * k, img.height * k);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

// obraz kafelka: zachowuje przezroczystość PNG/WebP/SVG
function resizeKeep(file, max) {
  if (file.type === 'image/svg+xml' && file.size < 400000) return resizeIcon(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(/jpe?g/.test(file.type) ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

function resizeImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const isPng = file.type === 'image/png' || file.type === 'image/svg+xml';
      resolve(c.toDataURL(isPng && scale === 1 && file.size < 500_000 ? 'image/png' : 'image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(); };
    img.src = url;
  });
}

function openModal(sel) {
  hideMenu();
  if (sel !== '#folder-modal') openFolderId = null;
  document.querySelectorAll('.modal').forEach(m => m.hidden = true);
  $(sel).hidden = false;
}
function closeModals() {
  document.querySelectorAll('.modal').forEach(m => m.hidden = true);
  openFolderId = null;
}
// Esc / tło: najpierw okno kafelka (może być nad folderem), potem reszta
function closeTop() {
  if (!$('#tile-modal').hidden && !$('#folder-modal').hidden) { closeTileModal(); return; }
  closeModals();
}

function toastPersistent(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 30000);
}

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(document.createTextNode(msg));
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.style.marginLeft = '12px';
    b.style.padding = '3px 10px';
    b.textContent = actionLabel;
    b.onclick = () => { t.hidden = true; action(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, actionLabel ? 6000 : 2500);
}

function tickClock() {
  if (!S().showClock) return;
  const now = new Date();
  $('#time').textContent = now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  $('#date').textContent = now.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
}

function doSearch(e) {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  if (!/\s/.test(q) && /^([a-z]+:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(q)) {
    location.href = normalizeUrl(q);
    return;
  }
  const eng = ENGINES[S().engine];
  if (!eng?.url && chrome.search?.query) {
    chrome.search.query({ text: q, disposition: 'CURRENT_TAB' });
  } else if (!eng?.url && chrome.search?.search) {
    chrome.search.search({ query: q, disposition: 'CURRENT_TAB' }); // Firefox
  } else {
    location.href = (eng?.url || ENGINES.google.url) + encodeURIComponent(q);
  }
}

/* ================= skróty klawiszowe ================= */

function onKey(e) {
  if (e.key === 'Escape' && selected.size && ![...document.querySelectorAll('.modal')].some(m => !m.hidden)) { clearSelection(); return; }
  if (e.key === 'Escape' && !$('#pad-panel').hidden && ![...document.querySelectorAll('.modal')].some(m => !m.hidden)) { togglePad(false); return; }
  if (e.key === 'Escape' && !$('#news-panel').hidden && ![...document.querySelectorAll('.modal')].some(m => !m.hidden)) { toggleNews(false); return; }
  if (e.key === 'Escape') { hideMenu(); closeTop(); return; }
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');
  const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);

  if (e.key === 'Alt') { document.body.classList.add('show-keys'); return; }
  if (inField || modalOpen) return;

  if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault();
    const g = currentGroup();
    if (!groupVisible(g)) return;
    const it = g.tiles[+e.code.slice(5) - 1];
    if (!it) return;
    if (isFolder(it)) return openFolder(it.id);
    if (it.incognito) return openIncognito([it.url]);
    if (e.shiftKey) chrome.tabs.create({ url: it.url, active: false });
    else if (S().openInNewTab) chrome.tabs.create({ url: it.url });
    else location.href = it.url;
    return;
  }
  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const i = data.groups.findIndex(g => g.id === data.activeGroup);
    const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + data.groups.length) % data.groups.length;
    switchGroup(data.groups[j].id);
    return;
  }
  if (e.key === '/' && S().showSearch) { e.preventDefault(); $('#q').focus(); }
  if (!RO() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !viewRecent) {
    e.preventDefault();
    document.querySelectorAll('#grid .tile[data-id]').forEach(el => selected.add(el.dataset.id));
    document.querySelectorAll('#grid .tile[data-id]').forEach(el => el.classList.add('selected'));
    updateSelBar();
  }
  if (e.key === 'Delete' && selected.size) { e.preventDefault(); selDelete(); }
}

/* ================= zdarzenia stałe ================= */

function bindStatic() {
  bindContainerDnD($('#grid'), true, true);
  bindPageDrop();
  bindContainerDnD($('#folder-grid'), false, false);
  bindSettings();

  // wyjmowanie z folderu: upuść poza oknem folderu
  const fm = $('#folder-modal');
  fm.addEventListener('dragover', e => {
    if (!dragId || e.target !== fm) return;
    e.preventDefault();
    fm.classList.add('drag-out');
  });
  fm.addEventListener('dragleave', e => { if (e.target === fm) fm.classList.remove('drag-out'); });
  fm.addEventListener('drop', e => {
    if (!dragId || e.target !== fm) return;
    e.preventDefault();
    fm.classList.remove('drag-out');
    dragHandled = true;
    moveOutOfFolder(dragId);
  });
  $('#folder-title').onchange = e => {
    const f = findItem(data, openFolderId).item;
    if (!isFolder(f)) return;
    f.title = e.target.value.trim() || 'Folder';
    save();
    renderGrid(false);
  };
  $('#folder-title').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#folder-open-all').onclick = () => {
    const f = findItem(data, openFolderId).item;
    if (isFolder(f)) openAll(f.tiles);
  };

  $('#btn-settings').onclick = openSettings;
  bindCrop();
  $('#btn-readonly').onclick = () => setReadOnly(false);
  $('#btn-news').onclick = () => toggleNews();
  bindPad();
  $('#news-close').onclick = () => toggleNews(false);
  $('#news-refresh').onclick = () => refreshNews(true);
  $('#news-settings').onclick = () => { toggleNews(false); openSettings('rss'); };
  $('#sel-open').onclick = () => { openAll(selTiles()); clearSelection(); };
  $('#sel-move').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.top - 8 - 36 * data.groups.length, data.groups.filter(groupVisible).map(g => ({ label: '→ ' + g.name, action: () => selMove(g.id) })));
  };
  $('#sel-folder').onclick = selFolder;
  $('#sel-shot').onclick = selCapture;
  $('#sel-del').onclick = selDelete;
  $('#sel-cancel').onclick = clearSelection;
  updateReadOnlyUI();
  $('#btn-lock').onclick = () => { setUnlocked(false); toast('Prywatne grupy zablokowane'); };
  $('#search').onsubmit = doSearch;
  $('#tile-form').onsubmit = submitTile;
  $('#name-form').onsubmit = e => {
    e.preventDefault();
    const v = $('#n-name').value.trim();
    if (!v) return;
    closeModals();
    nameSave?.(v);
  };
  $('#pin-form').onsubmit = submitPin;
  $('#bm-import').onclick = importBookmarks;

  // emoji
  const picker = $('#emoji-picker');
  EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.onclick = () => { $('#f-emoji').value = em; updateTilePreview(); };
    picker.append(b);
  });
  $('#f-emoji-clear').onclick = () => { $('#f-emoji').value = ''; updateTilePreview(); };

  $('#f-isize').oninput = e => { editIconSize = +e.target.value; updateIconSizeUI(); previewTileIconSize(); updateTilePreview(); };
  $('#f-isize-reset').onclick = () => { editIconSize = 0; updateIconSizeUI(); previewTileIconSize(); updateTilePreview(); };
  document.querySelectorAll('input[name="f-mode"]').forEach(r => r.onchange = () => {
    setMode(getMode());
    if (getMode() === 'custom') openGallery(true); // od razu szukaj logo strony
  });
  $('#f-url').addEventListener('change', () => { if (getMode() === 'custom' && !$('#f-gallery-col').hidden) { galleryFor = null; openGallery(false); } });
  $('#f-img-load').onclick = () => { const u = $('#f-img-url').value.trim(); if (u) loadImageFromUrl(normalizeUrl(u) || u); };
  $('#f-img-url').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#f-img-load').click(); } };
  $('#f-img-gallery').onclick = () => { galleryFor = null; openGallery(true); };
  $('#f-img-fit').onchange = updateImagePreview;
  $('#f-preview-now').onclick = () => {
    const it = editingId && findItem(data, editingId).item;
    if (!it) return;
    setMode('shot');
    captureOne(it);
  };
  $('#f-icon-pick').onclick = () => $('#f-icon-file').click();
  $('#f-icon-clear').onclick = () => { editIcon = null; updateIconPreview(); updateTilePreview(); };
  $('#f-icon-file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { editIcon = await resizeIcon(f); updateIconPreview(); updateTilePreview(); }
    catch { $('#f-error').textContent = 'Nie udało się wczytać ikony.'; }
  };
  $('#f-url').addEventListener('change', updateIconPreview);
  ['#f-url', '#f-title', '#f-emoji'].forEach(sel => $(sel).addEventListener('input', () => updateTilePreview()));
  $('#f-color').addEventListener('input', updateTilePreview);
  $('#f-color-auto').addEventListener('change', updateTilePreview);
  $('#f-color-auto').onchange = e => { $('#f-color').disabled = e.target.checked; };
  $('#f-image-pick').onclick = () => $('#f-image-file').click();
  $('#f-image-clear').onclick = () => { editImage = null; updateImagePreview(); };
  $('#f-image-file').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { editImage = await resizeKeep(f, 640); editImageSrc = null; setMode('custom'); updateImagePreview(); }
    catch { $('#f-error').textContent = 'Nie udało się wczytać obrazka.'; }
  };

  $('#tile-modal').querySelector('[data-close]').onclick = closeTileModal;
  document.querySelectorAll('.modal:not(#tile-modal) [data-close]').forEach(b => b.onclick = closeModals);
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('mousedown', e => { if (e.target === m) closeTop(); }));

  document.addEventListener('click', e => { if (!e.target.closest('#menu')) hideMenu(); });
  document.addEventListener('scroll', hideMenu, true);
  window.addEventListener('blur', () => { hideMenu(); document.body.classList.remove('show-keys'); });
  window.addEventListener('resize', hideMenu);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', e => { if (e.key === 'Alt' || !e.altKey) document.body.classList.remove('show-keys'); });

  document.addEventListener('contextmenu', e => {
    if (e.target.closest?.('.tile, .group-tab, input, textarea, .modal, .menu, #weather, .news-panel, .crop-layer, .selbar')) return;
    e.preventDefault();
    const g = currentGroup();
    const flat = g.tiles.flatMap(it => isFolder(it) ? it.tiles : [it]);
    if (RO()) {
      return showMenu(e.clientX, e.clientY, [
        { label: `Otwórz wszystkie z tej grupy (${flat.length})`, action: () => openAll(flat), disabled: !groupVisible(g) || !flat.length },
        { label: '🔓 Odblokuj edycję', action: () => setReadOnly(false) },
        { label: 'Ustawienia', action: openSettings }
      ]);
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Dodaj stronę…', action: () => openTileModal(null, null), disabled: !groupVisible(g) },
      { label: '🔒 Zablokuj układ (tylko do odczytu)', action: () => setReadOnly(true) },
      { label: `Otwórz wszystkie z tej grupy (${flat.length})`, action: () => openAll(flat), disabled: !groupVisible(g) || !flat.length },
      { label: 'Nowa grupa…', action: newGroup },
      { label: S().showSearch ? 'Ukryj wyszukiwarkę' : 'Pokaż wyszukiwarkę', action: () => setSetting('showSearch', !S().showSearch) },
      '-',
      { label: 'Importuj z zakładek…', action: openBookmarks },
      { label: 'Zmień tło…', action: () => openSettings('bg') },
      { label: '✋ Ustaw kadr tła…', action: startCrop, disabled: !PHOTO_BG.includes(effectiveBg().type) },
      { label: 'Ustawienia', action: openSettings }
    ]);
  });
}



/* ================= Notatnik i zadania ================= */

const P = () => data.pad;
let padTimer = null;

function togglePad(show) {
  const p = $('#pad-panel');
  const open = show ?? p.hidden;
  if (open && !$('#news-panel').hidden) toggleNews(false);
  p.hidden = !open;
  document.body.classList.toggle('news-open', open);
  if (open) {
    renderPad();
    setTimeout(() => (padTab() === 'notes' ? $('#pad-notes') : $('#pad-new')).focus(), 50);
  } else flushPad();
}

const padTab = () => document.querySelector('.pad-tab.active')?.dataset.tab || 'todo';

function setPadTab(t) {
  document.querySelectorAll('.pad-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.pad-body').forEach(b => { b.hidden = b.dataset.tab !== t; });
  try { localStorage.setItem('padTab', t); } catch {}
  (t === 'notes' ? $('#pad-notes') : $('#pad-new')).focus();
}

function updatePadButton() {
  const btn = $('#btn-pad');
  btn.hidden = !S().showPad;
  const left = P().todos.filter(t => !t.done).length;
  const c = $('#pad-count');
  c.hidden = !left;
  c.textContent = left > 99 ? '99+' : left;
  btn.title = left ? `Notatnik i zadania – ${plural(left, '1 zadanie do zrobienia', `${left} zadania do zrobienia`, `${left} zadań do zrobienia`)}` : 'Notatnik i zadania';
}

// soft = odświeżenie po zmianie z innej karty/komputera: nie przeszkadza w pisaniu
function renderPad(soft = false) {
  updatePadButton();
  if ($('#pad-panel').hidden) return;
  const notes = $('#pad-notes');
  if (!(soft && document.activeElement === notes) && notes.value !== P().notes) notes.value = P().notes;
  $('#pad-chars').textContent = P().notes.length ? `${P().notes.length} znaków` : '';
  if (soft && document.activeElement?.closest?.('#pad-list')) return;
  const list = $('#pad-list');
  list.innerHTML = '';
  const todos = P().todos;
  if (!todos.length) {
    const li = document.createElement('li');
    li.className = 'pad-empty';
    li.textContent = 'Brak zadań. Wpisz pierwsze powyżej.';
    list.append(li);
  }
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = 'pad-item' + (t.done ? ' done' : '');
    li.dataset.id = t.id;
    li.draggable = true;
    li.innerHTML = '<input type="checkbox"><span class="pad-text" title="Kliknij dwukrotnie, aby edytować"></span><button type="button" class="pad-del" title="Usuń">✕</button>';
    const cb = li.querySelector('input');
    cb.checked = !!t.done;
    cb.onchange = () => { t.done = cb.checked; t.doneAt = t.done ? Date.now() : null; save(); renderPad(); };
    const tx = li.querySelector('.pad-text');
    tx.textContent = t.text;
    tx.ondblclick = () => editTodo(li, t);
    li.querySelector('.pad-del').onclick = () => {
      P().todos = P().todos.filter(x => x !== t);
      save(); renderPad();
      toast('Usunięto zadanie', 'Cofnij', () => { P().todos.push(t); save(); renderPad(); });
    };
    li.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-pad', t.id); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); commitPadOrder(); });
    list.append(li);
  }
  const left = todos.filter(t => !t.done).length;
  const done = todos.length - left;
  $('#pad-todo-n').textContent = left ? `(${left})` : '';
  $('#pad-left').textContent = todos.length ? `${plural(left, '1 do zrobienia', `${left} do zrobienia`, `${left} do zrobienia`)} · ${done} ${plural(done, 'wykonane', 'wykonane', 'wykonanych')}` : '';
  $('#pad-clear').hidden = !done;
}

function editTodo(li, t) {
  const tx = li.querySelector('.pad-text');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'pad-edit';
  inp.value = t.text;
  inp.maxLength = 300;
  tx.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = ok => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (ok && v && v !== t.text) { t.text = v; save(); }
    renderPad();
  };
  inp.onkeydown = e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  };
  inp.onblur = () => finish(true);
}

function commitPadOrder() {
  const ids = [...document.querySelectorAll('#pad-list .pad-item')].map(li => li.dataset.id);
  const byId = new Map(P().todos.map(t => [t.id, t]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  if (next.length === P().todos.length && next.some((t, i) => t !== P().todos[i])) { P().todos = next; save(); }
}

function flushPad() {
  if (!padTimer) return;
  clearTimeout(padTimer);
  padTimer = null;
  save();
  $('#pad-saved').textContent = 'Zapisano';
}

function bindPad() {
  $('#btn-pad').onclick = () => togglePad();
  $('#pad-close').onclick = () => togglePad(false);
  document.querySelectorAll('.pad-tab').forEach(b => b.onclick = () => setPadTab(b.dataset.tab));
  try { const t = localStorage.getItem('padTab'); if (t === 'notes') setPadTab('notes'); } catch {}
  $('#pad-add').onsubmit = e => {
    e.preventDefault();
    const v = $('#pad-new').value.trim();
    if (!v) return;
    P().todos.push({ id: uid(), text: v, done: false, at: Date.now() });
    $('#pad-new').value = '';
    save();
    renderPad();
  };
  $('#pad-clear').onclick = () => {
    const removed = P().todos.filter(t => t.done);
    const before = P().todos.slice();
    P().todos = P().todos.filter(t => !t.done);
    save(); renderPad();
    toast(`Usunięto ${removed.length} ${plural(removed.length, 'wykonane zadanie', 'wykonane zadania', 'wykonanych zadań')}`, 'Cofnij', () => { P().todos = before; save(); renderPad(); });
  };
  $('#pad-notes').addEventListener('input', () => {
    P().notes = $('#pad-notes').value;
    $('#pad-saved').textContent = 'Zapisywanie…';
    $('#pad-chars').textContent = P().notes.length ? `${P().notes.length} znaków` : '';
    clearTimeout(padTimer);
    padTimer = setTimeout(flushPad, 600);
  });
  $('#pad-notes').addEventListener('blur', flushPad);
  window.addEventListener('beforeunload', flushPad);
  const list = $('#pad-list');
  list.addEventListener('dragover', e => {
    const dragging = list.querySelector('.pad-item.dragging');
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const over = e.target.closest('.pad-item');
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
  });
  list.addEventListener('drop', e => { if (list.querySelector('.dragging')) { e.preventDefault(); e.stopPropagation(); } });
  updatePadButton();
}


/* ================= Pogoda: deszcz w najbliższych godzinach ================= */

function rainSoon(j) {
  const h = j.hourly, c = j.current;
  if (!h?.time || !c) return null;
  if (c.weather_code >= 51 && c.weather_code !== 45 && c.weather_code !== 48) return null; // już pada
  const start = Math.max(0, h.time.findLastIndex(t => t <= c.time));
  for (let i = start; i < Math.min(h.time.length, start + 4); i++) {
    const p = h.precipitation_probability?.[i] ?? 0, mm = h.precipitation?.[i] ?? 0;
    if (p >= 60 || mm >= 0.3) {
      const snow = [71, 73, 75, 77, 85, 86].includes(h.weather_code[i]);
      const what = snow ? 'śnieg' : 'deszcz';
      const when = i === start ? 'w ciągu godziny' : `około ${h.time[i].slice(11, 16)}`;
      return { text: `${what[0].toUpperCase() + what.slice(1)} ${when}${p ? ` (${p}%)` : ''}`, at: h.time[i] };
    }
  }
  return null;
}

/* ================= Kursy walut (NBP) ================= */

const RATE_CODES = [['EUR', '€'], ['USD', '$'], ['CHF', 'CHF'], ['GBP', '£'], ['CZK', 'Kč'], ['NOK', 'NOK'], ['SEK', 'SEK'], ['UAH', '₴'], ['JPY', '¥']];
const fmtPl = (n, d = 4) => n.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });

async function loadRates(force = false) {
  const box = $('#rates');
  const s = S();
  if (!s.ratesOn) { box.hidden = true; return; }
  let cache = (await chrome.storage.local.get('ratesCache')).ratesCache;
  if (force || !cache || Date.now() - cache.at > 3 * 3600 * 1000) {
    try {
      const [t, g] = await Promise.all([
        fetch('https://api.nbp.pl/api/exchangerates/tables/A/last/2/?format=json').then(r => r.ok ? r.json() : Promise.reject(r.status)),
        fetch('https://api.nbp.pl/api/cenyzlota/last/2/?format=json').then(r => r.ok ? r.json() : null).catch(() => null)
      ]);
      cache = { at: Date.now(), tables: t, gold: g };
      await chrome.storage.local.set({ ratesCache: cache });
    } catch {
      if (!cache) { box.hidden = true; return; }
    }
  }
  renderRates(cache);
}

function renderRates(cache) {
  const box = $('#rates');
  const s = S();
  const [prev, cur] = cache.tables.length > 1 ? cache.tables : [null, cache.tables[0]];
  const items = [];
  const arrow = (a, b) => (b == null || a === b) ? '' : a > b ? '▲' : '▼';
  for (const [code, sym] of RATE_CODES) {
    if (!(s.rates || []).includes(code)) continue;
    const r = cur.rates.find(x => x.code === code);
    if (!r) continue;
    const p = prev?.rates.find(x => x.code === code)?.mid;
    items.push({ sym, val: r.mid, d: code === 'JPY' ? 4 : 2, arrow: arrow(r.mid, p), tip: `${r.currency} (${code}): ${fmtPl(r.mid)} zł${p ? `, poprzednio ${fmtPl(p)} zł` : ''}` });
  }
  if (s.ratesGold && cache.gold?.length) {
    const g = cache.gold.at(-1), gp = cache.gold.length > 1 ? cache.gold[0].cena : null;
    items.push({ sym: 'Au', val: g.cena, d: 0, arrow: arrow(g.cena, gp), tip: `Złoto: ${fmtPl(g.cena, 2)} zł za gram (${g.data})` });
  }
  box.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'rate';
    el.title = it.tip;
    el.innerHTML = '<b></b> <span></span><i></i>';
    el.querySelector('b').textContent = it.sym;
    el.querySelector('span').textContent = fmtPl(it.val, it.d);
    const a = el.querySelector('i');
    a.textContent = it.arrow;
    a.className = it.arrow === '▲' ? 'up' : it.arrow === '▼' ? 'down' : '';
    box.append(el);
  }
  box.title = `Średnie kursy NBP z ${cur.effectiveDate} (tabela ${cur.no})`;
  box.hidden = !items.length;
  const info = $('#s-rates-info');
  if (info) info.textContent = `Tabela NBP ${cur.no} z ${cur.effectiveDate}`;
}

function renderRatePicks() {
  const box = $('#s-rates');
  box.innerHTML = '';
  const s = S();
  const pick = (code, label, on, set) => {
    const l = document.createElement('label');
    l.className = 'rate-pick' + (on ? ' on' : '');
    l.innerHTML = '<input type="checkbox"><span></span>';
    l.querySelector('span').textContent = label;
    const cb = l.querySelector('input');
    cb.checked = on;
    cb.onchange = () => { set(cb.checked); l.classList.toggle('on', cb.checked); save(); loadRates(); };
    box.append(l);
  };
  for (const [code] of RATE_CODES) pick(code, code, (s.rates || []).includes(code), on => {
    const set = new Set(S().rates || []);
    on ? set.add(code) : set.delete(code);
    S().rates = RATE_CODES.map(x => x[0]).filter(c => set.has(c));
  });
  pick('XAU', 'Złoto', !!s.ratesGold, on => { S().ratesGold = on; });
}

/* ================= Odliczanie ================= */

const DAY_MS = 864e5;
function cdTarget(c, today) {
  let d = new Date(c.date + 'T00:00');
  if (c.yearly) {
    d.setFullYear(today.getFullYear());
    if (d < today) d.setFullYear(today.getFullYear() + 1);
  }
  return d;
}

function renderCountdowns() {
  const box = $('#countdowns');
  const s = S();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const list = (s.countdowns || [])
    .map(c => ({ c, d: cdTarget(c, today) }))
    .map(x => ({ ...x, days: Math.round((x.d - today) / DAY_MS) }))
    .filter(x => x.days >= 0)
    .sort((a, b) => a.days - b.days);
  box.innerHTML = '';
  for (const { c, d, days } of list) {
    const el = document.createElement('span');
    el.className = 'cd' + (days === 0 ? ' today' : days <= 7 ? ' soon' : '');
    el.title = d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    el.innerHTML = '<b></b><span></span>';
    el.querySelector('b').textContent = c.name;
    el.querySelector('span').textContent = days === 0 ? 'dziś!' : days === 1 ? 'jutro' : `za ${days} dni`;
    box.append(el);
  }
  box.hidden = s.countdownOn === false || !list.length;
}

function renderCdList() {
  const box = $('#cd-list');
  box.innerHTML = '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const c of S().countdowns || []) {
    const row = document.createElement('div');
    row.className = 'set-row cd-row';
    const d = cdTarget(c, today);
    const days = Math.round((d - today) / DAY_MS);
    row.innerHTML = '<div class="set-text"><div class="set-name"></div><div class="set-desc"></div></div><div class="set-ctl"><button type="button" class="btn ghost">Usuń</button></div>';
    row.querySelector('.set-name').textContent = c.name;
    row.querySelector('.set-desc').textContent = `${new Date(c.date + 'T00:00').toLocaleDateString('pl-PL')}${c.yearly ? ' · co roku' : ''} · ${days < 0 ? 'minęło' : days === 0 ? 'dziś' : `za ${days} dni`}`;
    row.querySelector('button').onclick = () => {
      S().countdowns = S().countdowns.filter(x => x !== c);
      save(); renderCdList(); renderCountdowns();
    };
    box.append(row);
  }
}

/* ================= Efekt 3D kafelków ================= */

function bindTilt() {
  const grid = document.querySelector('main');
  let raf = 0;
  grid.addEventListener('mousemove', e => {
    if (S().tileHover !== 'tilt') return;
    const tile = e.target.closest('.tile');
    if (!tile || dragId) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const r = tile.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      tile.style.setProperty('--ry', ((x - .5) * 16).toFixed(2) + 'deg');
      tile.style.setProperty('--rx', ((.5 - y) * 16).toFixed(2) + 'deg');
      tile.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      tile.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    });
  });
  grid.addEventListener('mouseout', e => {
    const tile = e.target.closest?.('.tile');
    if (tile && !tile.contains(e.relatedTarget)) ['--rx', '--ry', '--mx', '--my'].forEach(v => tile.style.removeProperty(v));
  });
}
