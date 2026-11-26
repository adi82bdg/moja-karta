// Wspólne funkcje: wyszukiwanie logo (galeria FVD + strona) i pobieranie obrazów.
// Działa zarówno na stronie nowej karty, jak i w tle.

export async function fetchT(url, ms = 6000, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

export const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&') : null;
};

export function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

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

export async function findSiteImages(url) {
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
  (await galleryP).forEach(src => out.push({ src, kind: 'Galeria logo', prio: 0 }));
  const seen = new Set();
  return out.filter(x => !seen.has(x.src) && seen.add(x.src))
    .sort((a, b) => a.prio - b.prio).slice(0, 24);
}

export async function fetchImageData(url, max = 640) {
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
