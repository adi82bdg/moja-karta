// Czytnik RSS/Atom – pobieranie, wykrywanie kanałów i parsowanie (działa na stronie nowej karty)

async function fetchText(url, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    // kodowanie: nagłówek, deklaracja XML lub meta – polskie kanały bywają w ISO-8859-2 / Windows-1250
    const ct = r.headers.get('content-type') || '';
    let enc = (ct.match(/charset=([\w-]+)/i) || [])[1];
    if (!enc) {
      const head = new TextDecoder('latin1').decode(buf.slice(0, 1024));
      enc = (head.match(/encoding=["']([\w-]+)["']/i) || head.match(/charset=["']?([\w-]+)/i) || [])[1];
    }
    let text;
    try { text = new TextDecoder(enc || 'utf-8').decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
    return { text, url: r.url || url, type: ct };
  } finally { clearTimeout(t); }
}

const looksLikeFeed = s => /<(rss|feed|rdf:RDF)[\s>]/i.test(s.slice(0, 3000));

export function parseFeed(text, base) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('to nie jest kanał RSS');
  const txt = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
  const isAtom = !!doc.querySelector('feed');
  const title = isAtom ? txt(doc, 'feed > title') : (txt(doc, 'channel > title') || txt(doc, 'title'));
  const items = [];
  const nodes = isAtom ? doc.querySelectorAll('entry') : doc.querySelectorAll('item');
  nodes.forEach(n => {
    let link;
    if (isAtom) {
      const l = [...n.querySelectorAll('link')].find(x => !x.getAttribute('rel') || x.getAttribute('rel') === 'alternate') || n.querySelector('link');
      link = l?.getAttribute('href');
    } else link = txt(n, 'link') || n.querySelector('guid')?.textContent;
    const d = txt(n, 'pubDate') || txt(n, 'published') || txt(n, 'updated') || txt(n, 'date');
    const t = (txt(n, 'title') || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    if (!t || !link) return;
    let abs = link;
    try { abs = new URL(link.trim(), base).href; } catch {}
    const time = Date.parse(d);
    items.push({ title: t.slice(0, 220), link: abs, date: isNaN(time) ? 0 : time });
  });
  return { title: title || new URL(base).hostname, items };
}

// Z adresu strony lub kanału zwraca adres kanału i jego tytuł
export async function discoverFeed(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const first = await fetchText(url);
  if (looksLikeFeed(first.text)) return { url: first.url, title: parseFeed(first.text, first.url).title };
  // <link rel="alternate" type="application/rss+xml">
  for (const m of first.text.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag) || !/(rss|atom)\+xml/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const feedUrl = new URL(href.replace(/&amp;/g, '&'), first.url).href;
    try {
      const f = await fetchText(feedUrl);
      if (looksLikeFeed(f.text)) return { url: f.url, title: parseFeed(f.text, f.url).title };
    } catch {}
  }
  // typowe adresy
  const origin = new URL(first.url).origin;
  for (const p of ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed/']) {
    try {
      const f = await fetchText(origin + p, 7000);
      if (looksLikeFeed(f.text)) return { url: f.url, title: parseFeed(f.text, f.url).title };
    } catch {}
  }
  throw new Error('nie znaleziono kanału RSS na tej stronie');
}

export async function loadFeed(url) {
  const f = await fetchText(url);
  return parseFeed(f.text, f.url);
}
