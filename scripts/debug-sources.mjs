// GEÇİCİ tanı betiği: Steam ve LootScraper'ın gerçek yanıtlarını özetler. İşi bitince silinecek.
import { writeFile } from 'node:fs/promises';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const out = [];
const log = (...a) => out.push(a.join(' '));
const strip = (t) => t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const steam = (extra) => `https://store.steampowered.com/search/results/?query&start=0&count=100&sort_by=Released_DESC&infinite=1&cc=TR&l=turkish${extra}`;
for (const [name, extra] of [
  ['mevcut sorgu', '&maxprice=free&specials=1&category1=998'],
  ['sadece indirimdekiler', '&specials=1&category1=998'],
  ['hepsi (DLC dahil) maxprice=free+specials', '&maxprice=free&specials=1'],
]) {
  try {
    const r = await fetch(steam(extra), { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9' } });
    const j = await r.json();
    const rows = [...(j.results_html ?? '').matchAll(/<a\b[^>]*search_result_row[\s\S]*?<\/a>/g)].map((m) => m[0]);
    const pcts = rows.map((b) => b.match(/discount_pct">\s*(-?\d+)%/)?.[1] ?? '?');
    log(`STEAM [${name}] HTTP ${r.status} total_count=${j.total_count} satır=${rows.length} yüzde100=${pcts.filter((p) => p === '100').length} yüzdesiz=${pcts.filter((p) => p === '?').length}`);
    for (const b of rows.slice(0, 12)) log('   ', b.match(/data-ds-appid="(\d+)"/)?.[1], '|', strip(b.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1] ?? '?'), '| yüzde:', b.match(/discount_pct">\s*(-?\d+)%/)?.[1] ?? '?', '| fiyat:', strip(b.match(/search_price_discount_combined[\s\S]*?<\/div>/)?.[0] ?? '').slice(0, 40));
  } catch (e) { log(`STEAM [${name}] HATA: ${e.message}`); }
}

const catOf = (e, kind) => e.match(new RegExp(`<category\\b[^>]*scheme="[^"]*/${kind}"[^>]*label="([^"]*)"`))?.[1] ?? '';
try {
  const r = await fetch('https://feed.eikowagenknecht.com/lootscraper.xml', { headers: { 'user-agent': UA } });
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]).map((e) => ({
    title: strip(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    source: catOf(e, 'source'), platform: catOf(e, 'platform'), type: catOf(e, 'type'),
    published: e.match(/<published>([^<]+)</)?.[1] ?? '',
  }));
  log(`\nLOOTSCRAPER HTTP ${r.status}, ${entries.length} kayıt, en yeni ${entries.map((x) => x.published).sort().at(-1)}, en eski ${entries.map((x) => x.published).sort()[0]}`);
  const counts = {};
  for (const x of entries) { const k = `${x.source} | ${x.platform} | ${x.type}`; counts[k] = (counts[k] ?? 0) + 1; }
  for (const [k, v] of Object.entries(counts).sort()) log('   ', v, 'x', k);
  log('\nGoogle Play / Android kayıtları:');
  for (const x of entries.filter((x) => /google|play|android/i.test(`${x.source} ${x.platform}`))) log('   ', x.published, '|', x.source, '|', x.platform, '|', x.type, '|', x.title.slice(0, 80));
} catch (e) { log(`LOOTSCRAPER HATA: ${e.message}`); }

await writeFile('free-games/debug.txt', out.join('\n') + '\n');
console.log(out.join('\n'));
