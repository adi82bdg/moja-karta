// Wspólne funkcje danych – używane przez nową kartę, popup i tło.

export const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);

export const DEFAULT_SETTINGS = {
  columns: 6,
  tileSize: 'm',          // s | m | l
  layout: 'modern',       // modern | classic (jak FVD)
  tileStyle: 'color',     // color | glass | clear
  iconStyle: 'clear',     // clear | box
  iconSize: 0,            // % szerokości kafelka; 0 = automatycznie
  frame: 'normal',        // obramowanie: normal | soft | none
  tileBgAlpha: 0,         // tło kafelka w %: 0 = przezroczyste (jak FVD)
  showTitles: true,
  showAddTile: true,      // kafelek „+ Dodaj”
  showRecent: true,       // zakładka „Ostatnio zamknięte”
  showNotes: true,        // notatki pod kafelkami
  readOnly: false,        // tryb tylko do odczytu (blokada edycji)
  rssOn: true,            // przycisk wiadomości (RSS)
  showPad: true,          // przycisk notatnika i zadań
  ratesOn: false,         // kursy walut NBP
  rates: ['EUR', 'USD', 'CHF'],
  ratesGold: false,       // cena złota NBP
  countdownOn: true,      // odliczanie do dat pod zegarem
  countdowns: [],         // [{ id, name, date: 'YYYY-MM-DD', yearly }]
  weatherRain: true,      // ostrzeżenie o deszczu w najbliższych godzinach
  tileHover: 'lift',      // efekt po najechaniu: none | lift | zoom | glow | tilt
  rssFeeds: [],           // [{ url, title }]
  rssMax: 50,
  rssSeen: 0,             // znacznik przeczytanych wiadomości
  bgPos: null,            // kadr zdjęcia tła { x, y, z } w %
  fx: 'off',              // animowane tło: off | snow | stars | rain | fireflies
  openOnStartup: null,    // otwórz Moją Kartę przy starcie przeglądarki (null = tylko w Operze)
  fxAmount: 2,            // 1 mało, 2 średnio, 3 dużo
  monitorOn: false,       // sprawdzanie, czy strony działają
  monitorEvery: 60,       // co ile minut (monitor + obserwowanie zmian)
  watchNotify: true,      // powiadomienie systemowe o zmianach
  backupMode: 'weekly',   // automatyczna kopia: off | daily | weekly
  showSearch: true,
  engine: 'chrome',
  showClock: true,
  openInNewTab: false,
  theme: 'dark',          // dark | light
  bgType: 'gradient',     // gradient | color | image | bing | wood
  bgGradient: 0,
  bgColor: '#1e2433',
  bgDim: 30,
  rotateMode: 'day',      // zmieniające się zdjęcia: day | hour | open
  titleFont: 'system',    // czcionka nazw kafelków
  titleSize: 13,
  titleBold: false,
  titleColor: null,       // null = automatyczny
  thumbnails: false,      // podglądy stron
  badges: false,          // liczniki powiadomień
  weatherOn: false,
  weatherLoc: null,       // { name, lat, lon }
  sync: false,
  pinHash: null,
  pinSalt: null
};

export const GRADIENTS = [
  'linear-gradient(135deg,#1f2a44 0%,#3a1c4a 100%)',
  'linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%)',
  'linear-gradient(135deg,#232526 0%,#414345 100%)',
  'linear-gradient(135deg,#42275a 0%,#734b6d 100%)',
  'linear-gradient(135deg,#134e5e 0%,#71b280 100%)',
  'linear-gradient(135deg,#ee9ca7 0%,#ffdde1 100%)',
  'linear-gradient(135deg,#a1c4fd 0%,#c2e9fb 100%)',
  'linear-gradient(135deg,#f6d365 0%,#fda085 100%)'
];

export const ENGINES = {
  chrome:     { name: 'Domyślna wyszukiwarka Chrome', url: null },
  google:     { name: 'Google',     url: 'https://www.google.com/search?q=' },
  bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  brave:      { name: 'Brave',      url: 'https://search.brave.com/search?q=' }
};

export function makeTile(url, title) {
  return { id: uid(), url, title, color: null, image: null, emoji: null, icon: null };
}
export function makeFolder(title, tiles = []) {
  return { id: uid(), type: 'folder', title: title || 'Folder', tiles };
}
export const isFolder = it => it && it.type === 'folder';

export function defaultData() {
  const g = {
    id: uid(),
    name: 'Główne',
    locked: false,
    tiles: [
      makeTile('https://www.google.com/', 'Google'),
      makeTile('https://www.youtube.com/', 'YouTube'),
      makeTile('https://mail.google.com/', 'Gmail'),
      makeTile('https://allegro.pl/', 'Allegro'),
      makeTile('https://pl.wikipedia.org/', 'Wikipedia'),
      makeTile('https://github.com/', 'GitHub')
    ]
  };
  return { version: 2, updatedAt: 0, groups: [g], activeGroup: g.id, settings: { ...DEFAULT_SETTINGS } };
}

function normItems(arr, depth) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(Boolean).map(it => {
    if (isFolder(it)) {
      if (depth > 0) return null; // bez folderów w folderach
      it.id ||= uid();
      it.title ||= 'Folder';
      it.tiles = normItems(it.tiles, depth + 1).filter(x => !isFolder(x));
      return it;
    }
    if (!it.url) return null;
    it.id ||= uid();
    it.title ||= titleFromUrl(it.url);
    return it;
  }).filter(Boolean);
}

export function normalizeData(d) {
  if (!d || !Array.isArray(d.groups) || d.groups.length === 0) return null;
  d.groups.forEach(g => {
    g.id ||= uid();
    g.name ||= 'Grupa';
    g.locked = !!g.locked;
    g.tiles = normItems(g.tiles, 0);
  });
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  // jednorazowo: ramka jak w FVD – przezroczysty środek
  if (!d.settings.frameV2) { d.settings.tileBgAlpha = 0; d.settings.frame = 'normal'; d.settings.frameV2 = true; }
  d.updatedAt ||= 0;
  d.pad = { notes: '', todos: [], ...(d.pad || {}) };
  if (!Array.isArray(d.pad.todos)) d.pad.todos = [];
  if (!d.groups.some(g => g.id === d.activeGroup)) d.activeGroup = d.groups[0].id;
  return d;
}

/* ---------- przeglądanie drzewa ---------- */

// wszystkie kafelki-strony (również te w folderach)
export function allTiles(data) {
  const out = [];
  for (const g of data.groups)
    for (const it of g.tiles)
      if (isFolder(it)) it.tiles.forEach(t => out.push({ tile: t, group: g, folder: it }));
      else out.push({ tile: it, group: g, folder: null });
  return out;
}

// znajdź element (kafelek lub folder) – zwraca tablicę-rodzica
export function findItem(data, id) {
  for (const g of data.groups) {
    for (const it of g.tiles) {
      if (it.id === id) return { item: it, list: g.tiles, group: g, folder: null };
      if (isFolder(it)) {
        const t = it.tiles.find(x => x.id === id);
        if (t) return { item: t, list: it.tiles, group: g, folder: it };
      }
    }
  }
  return {};
}

/* ---------- zapis / odczyt ---------- */

export async function loadLocal() {
  const r = await chrome.storage.local.get('data');
  return normalizeData(r.data);
}

export async function loadData() {
  let d = await loadLocal();
  if (!d) {
    d = defaultData();
    await chrome.storage.local.set({ data: d });
  }
  if (d.settings.sync) {
    try {
      const remote = await pullSync();
      if (remote && remote.updatedAt > d.updatedAt) {
        d = mergeRemote(remote, d);
        await chrome.storage.local.set({ data: d });
      }
    } catch (e) { console.warn('sync pull', e); }
  }
  return d;
}

let syncTimer = null;
export async function saveData(d, { syncNow = false } = {}) {
  d.updatedAt = Date.now();
  await chrome.storage.local.set({ data: d });
  if (d.settings.sync) {
    clearTimeout(syncTimer);
    if (syncNow) return pushSync(d).catch(e => console.warn('sync push', e));
    syncTimer = setTimeout(() => pushSync(d).catch(e => reportSyncError(e)), 1500);
  }
}

// zapis lokalny bez zmiany znacznika czasu (np. po pobraniu z chmury)
export function saveLocalOnly(d) {
  return chrome.storage.local.set({ data: d });
}

/* ---------- synchronizacja (chrome.storage.sync) ---------- */

const CHUNK = 2000;      // znaków na element (limit 8 KB / element)
const PREFIX = 'sd_';

function stripImages(d) {
  const c = structuredClone(d);
  const strip = arr => arr.forEach(it => { if (isFolder(it)) strip(it.tiles); else { it.image = null; it.icon = null; } });
  c.groups.forEach(g => strip(g.tiles));
  return c;
}

export async function pushSync(d) {
  const json = JSON.stringify(stripImages(d));
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  const old = (await chrome.storage.sync.get(PREFIX + 'meta'))[PREFIX + 'meta'];
  const items = { [PREFIX + 'meta']: { n: parts.length, updatedAt: d.updatedAt } };
  parts.forEach((p, i) => items[PREFIX + i] = p);
  await chrome.storage.sync.set(items);
  if (old && old.n > parts.length) {
    const rm = [];
    for (let i = parts.length; i < old.n; i++) rm.push(PREFIX + i);
    await chrome.storage.sync.remove(rm);
  }
  await chrome.storage.local.set({ syncStatus: { ok: true, at: Date.now(), size: json.length } });
}

function reportSyncError(e) {
  console.warn('sync push', e);
  chrome.storage.local.set({ syncStatus: { ok: false, at: Date.now(), error: String(e?.message || e) } });
}

export async function pullSync() {
  const meta = (await chrome.storage.sync.get(PREFIX + 'meta'))[PREFIX + 'meta'];
  if (!meta || !meta.n) return null;
  const keys = Array.from({ length: meta.n }, (_, i) => PREFIX + i);
  const r = await chrome.storage.sync.get(keys);
  if (keys.some(k => typeof r[k] !== 'string')) return null;
  const d = normalizeData(JSON.parse(keys.map(k => r[k]).join('')));
  if (!d) return null;
  d.updatedAt = meta.updatedAt;
  return d;
}

// dane z chmury + lokalne obrazki (których nie synchronizujemy)
export function mergeRemote(remote, local) {
  const imgs = new Map();
  if (local) allTiles(local).forEach(({ tile }) => { if (tile.image) imgs.set(tile.id, tile.image); });
  allTiles(remote).forEach(({ tile }) => { if (!tile.image && imgs.has(tile.id)) tile.image = imgs.get(tile.id); });
  remote.settings.sync = true;
  return remote;
}

/* ---------- PIN ---------- */

export async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- adresy ---------- */

export function normalizeUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return ''; }
}

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

export function titleFromUrl(u) {
  const parts = hostOf(u).split('.');
  const n = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : u;
}

export function addTile(data, groupId, { url, title }) {
  const g = data.groups.find(x => x.id === groupId) || data.groups[0];
  const t = makeTile(url, (title || '').trim() || titleFromUrl(url));
  g.tiles.push(t);
  return t;
}

export function urlKey(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
  } catch { return (u || '').toLowerCase(); }
}

// Dodatkowe dane do kopii zapasowej: podglądy stron, tła grup, zdjęcia rotacji, ikony
const EXTRA_PREFIXES = ['thumb_', 'gbg_', 'icon_'];
const EXTRA_KEYS = ['bgRotate', 'bingCache'];
export async function collectExtras() {
  const all = await chrome.storage.local.get(null);
  const out = {};
  for (const k in all) if (EXTRA_KEYS.includes(k) || EXTRA_PREFIXES.some(p => k.startsWith(p))) out[k] = all[k];
  return out;
}
export async function restoreExtras(extras) {
  if (!extras || typeof extras !== 'object') return 0;
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter(k => EXTRA_KEYS.includes(k) || EXTRA_PREFIXES.some(p => k.startsWith(p)));
  if (old.length) await chrome.storage.local.remove(old);
  const clean = {};
  for (const k in extras) if (EXTRA_KEYS.includes(k) || EXTRA_PREFIXES.some(p => k.startsWith(p))) clean[k] = extras[k];
  await chrome.storage.local.set(clean);
  return Object.keys(clean).length;
}

export function isAddableUrl(u) {
  return /^(https?|file|ftp):/i.test(u || '');
}

// dopasowanie adresu karty do kafelka (najdłuższa pasująca ścieżka)
export function matchTile(data, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  let best = null, bestLen = -1;
  for (const { tile } of allTiles(data)) {
    let t;
    try { t = new URL(tile.url); } catch { continue; }
    if (t.hostname.replace(/^www\./, '') !== host) continue;
    if (!u.pathname.startsWith(t.pathname)) continue;
    if (t.pathname.length > bestLen) { best = tile; bestLen = t.pathname.length; }
  }
  return best;
}
