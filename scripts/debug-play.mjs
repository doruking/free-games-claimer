// GEÇİCİ tanı betiği: 9to5toys Google Play fırsatları yazılarının gerçek yapısını özetler. İşi bitince silinecek.
import { writeFile } from 'node:fs/promises';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const out = [];
const log = (...a) => out.push(a.join(' '));
const feeds = [
  'https://9to5toys.com/feed/',
  'https://9to5toys.com/?s=google+play+deals&feed=rss2',
  'https://9to5toys.com/tag/google-play-deals/feed/',
  'https://9to5toys.com/guides/android/feed/',
  'https://9to5toys.com/guides/apps/feed/',
];
let newest = null;
for (const u of feeds) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    const x = await r.text();
    const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    const gp = items.map((i) => ({ link: (i.match(/<link>([^<]+)<\/link>/)?.[1] ?? '').trim(), date: i.match(/<pubDate>([^<]+)</)?.[1] })).filter((i) => /google-play-deals/i.test(i.link));
    log(`FEED ${u} HTTP ${r.status} öğe=${items.length} googleplay=${gp.length} ilk=${gp[0]?.link ?? '-'} ${gp[0]?.date ?? ''}`);
    if (!newest && gp[0]) newest = gp[0].link;
  } catch (e) { log(`FEED ${u} HATA ${e.message}`); }
}
const art = newest ?? 'https://9to5toys.com/2026/11/12/todays-highlight-google-play-deals-48/';
log('\nMAKALE', art, newest ? '(yayından)' : '(bilinen adres)');
try {
  const r = await fetch(art, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  const h = await r.text();
  log('HTTP', r.status, 'uzunluk', h.length);
  const re = /play\.google\.com\/store\/apps\/details\?id=([\w.]+)/g;
  const links = [...h.matchAll(re)];
  log('play bağlantısı:', links.length, 'benzersiz:', new Set(links.map((m) => m[1])).size);
  for (const idx of [0, 1, 2]) {
    const m = links[idx];
    if (m) log(`\n--- bağlantı #${idx + 1} çevresi:\n`, h.slice(Math.max(0, m.index - 500), m.index + 500).replace(/\s+/g, ' '));
  }
  for (const m of [...h.matchAll(/\bFREE\b/g)].slice(0, 2)) log('\n--- FREE çevresi:\n', h.slice(Math.max(0, m.index - 300), m.index + 200).replace(/\s+/g, ' '));
} catch (e) { log('MAKALE HATA', e.message); }
await writeFile('free-games/debug.txt', out.join('\n') + '\n');
console.log(out.join('\n'));
