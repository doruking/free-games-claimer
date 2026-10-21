// Epic Games Store ve Fab'daki ücretsiz içerikleri kontrol eder, free-games/ altına yazar,
// liste değiştiyse bildirim gönderir (ntfy telefon bildirimi, Discord, Telegram, GitHub Issue).
// Bağımlılık yok: Node 18+ (yerleşik fetch) yeterli. Şifre ya da giriş bilgisi gerektirmez.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const LOCALE = process.env.EPIC_LOCALE || 'tr';
const COUNTRY = process.env.EPIC_COUNTRY || 'TR';
const OUT_DIR = 'free-games';
const EPIC_API = `https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=${LOCALE}&country=${COUNTRY}&allowCountries=${COUNTRY}`;
const EPIC_FALLBACK_URL = `https://store.epicgames.com/${LOCALE}/free-games`;
const FAB_URL = 'https://www.fab.com/limited-time-free';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';

const now = Date.now();
const fmt = (iso) => new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'long', timeStyle: 'short' });

// ---------- Epic Games Store ----------
const slugOf = (el) => {
  const slug = el.offerMappings?.[0]?.pageSlug
    ?? el.catalogNs?.mappings?.[0]?.pageSlug
    ?? el.productSlug
    ?? el.urlSlug;
  if (!slug || slug === '[]') return null;
  return slug.replace(/\/home$/, '');
};
const linkOf = (el) => {
  const slug = slugOf(el);
  return slug ? `https://store.epicgames.com/${LOCALE}/p/${slug}` : EPIC_FALLBACK_URL;
};
// Epic'te discountPercentage === 0 "yüzde yüz indirim" (bedava) demektir.
const windowsOf = (el, kind) => (el.promotions?.[kind] ?? [])
  .flatMap((p) => p.promotionalOffers ?? [])
  .filter((o) => o.discountSetting?.discountPercentage === 0)
  .map((o) => ({ start: Date.parse(o.startDate), end: Date.parse(o.endDate) }));

async function getEpic() {
  const res = await fetch(EPIC_API, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Epic API hata verdi: HTTP ${res.status}`);
  const elements = (await res.json())?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new Error('Epic API yanıtı beklenen biçimde değil (elements yok).');

  const current = [];
  const upcoming = [];
  for (const el of elements) {
    const base = { id: el.id, title: el.title, url: linkOf(el) };
    const active = windowsOf(el, 'promotionalOffers').find((w) => w.start <= now && now < w.end);
    if (active) {
      current.push({ ...base, endsAt: new Date(active.end).toISOString() });
      continue;
    }
    const next = windowsOf(el, 'upcomingPromotionalOffers').filter((w) => w.start > now).sort((a, b) => a.start - b.start)[0];
    if (next) upcoming.push({ ...base, startsAt: new Date(next.start).toISOString(), endsAt: new Date(next.end).toISOString() });
  }
  current.sort((a, b) => a.title.localeCompare(b.title));
  upcoming.sort((a, b) => a.title.localeCompare(b.title));
  return { key: current.map((g) => `${g.id}@${g.endsAt}`).sort().join('|'), current, upcoming };
}

// ---------- Steam (kalıcı ücretsiz: %100 indirimli oyunlar) ----------
// Free-to-play oyunlar ve "hafta sonu ücretsiz" denemeleri bu listeye girmez; sadece hesaba kalıcı eklenenler.
const decode = (t) => t
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function getSteam() {
  const url = `https://store.steampowered.com/search/results/?query&start=0&count=100&sort_by=Released_DESC&maxprice=free&specials=1&category1=998&infinite=1&cc=${COUNTRY}&l=turkish`;
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9' } });
  if (!res.ok) throw new Error(`Steam hata verdi: HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data?.results_html !== 'string') throw new Error('Steam yanıtı beklenen biçimde değil.');

  const items = [];
  for (const m of data.results_html.matchAll(/<a\b[^>]*search_result_row[\s\S]*?<\/a>/g)) {
    const block = m[0];
    const id = block.match(/data-ds-appid="(\d+)"/)?.[1];
    const title = block.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1];
    const pct = block.match(/discount_pct">\s*-?(\d+)%/)?.[1];
    if (!id || !title || pct !== '100') continue;
    items.push({ id, title: decode(title), url: `https://store.steampowered.com/app/${id}/` });
  }
  if (!items.length && Number(data.total_count) > 0) throw new Error('Steam sonuçları ayrıştırılamadı.');
  items.sort((a, b) => a.title.localeCompare(b.title));
  return { key: items.map((i) => i.id).sort().join('|'), items };
}

// ---------- GOG (indirimle bedava olan oyunlar; DRM'siz, hesaba kalıcı eklenir) ----------
const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && String(v ?? '') !== '' ? n : NaN;
};

async function getGog() {
  const url = `https://catalog.gog.com/v1/catalog?limit=48&page=1&order=desc%3Atrending&productType=in%3Agame%2Cpack&price=between%3A0%2C0&discounted=eq%3Atrue&countryCode=${COUNTRY}&locale=tr-TR&currencyCode=USD`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`GOG hata verdi: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.products)) throw new Error('GOG yanıtı beklenen biçimde değil (products yok).');

  // DLC'ler ayrı sorguyla alınır; bu sorgu başarısız olsa bile oyun listesi etkilenmez.
  const dlcProducts = [];
  try {
    const r2 = await fetch(url.replace('in%3Agame%2Cpack', 'in%3Adlc'), { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r2.ok) dlcProducts.push(...((await r2.json())?.products ?? []));
  } catch { /* yok say */ }
  const items = [];
  for (const p of [...data.products, ...dlcProducts.map((d) => ({ ...d, title: `${d.title} [DLC]` }))]) {
    const final = money(p.price?.finalMoney?.amount ?? p.price?.final);
    const base = money(p.price?.baseMoney?.amount ?? p.price?.base);
    if (!p.id || !p.title || final !== 0 || !(base > 0)) continue; // sadece indirimle bedava olanlar
    items.push({ id: String(p.id), title: decode(p.title), url: p.storeLink ?? `https://www.gog.com/en/game/${p.slug}` });
  }
  if (!items.length && data.products.length) {
    const first = data.products[0];
    throw new Error(`GOG ürünleri ayrıştırılamadı (alanlar: ${Object.keys(first).join(',')}; fiyat: ${JSON.stringify(first.price)?.slice(0, 120)})`);
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return { key: items.map((i) => i.id).sort().join('|'), items };
}

// ---------- LootScraper (Prime Gaming, Humble, App Store, Play Store, Fab, Epic mobil) ----------
// Açık kaynak LootScraper projesinin herkese açık Atom yayını. Steam, GOG ve Epic PC zaten yukarıda doğrudan kontrol edilir.
const LOOT_FEED = 'https://feed.eikowagenknecht.com/lootscraper.xml';
const LOOT_SKIP_SOURCES = new Set(['steam', 'gog', 'apple app store']); // App Store kullanıcı isteğiyle kapalı
const DAY = 86400000;

// Kategori etiketini okur, ör. <category term="platform:PC" scheme=".../platform" label="PC"/>
const catOf = (e, kind) => e.match(new RegExp(`<category\\b[^>]*scheme="[^"]*/${kind}"[^>]*label="([^"]*)"`))?.[1]
  ?? e.match(new RegExp(`<category\\b[^>]*label="([^"]*)"[^>]*scheme="[^"]*/${kind}"`))?.[1] ?? '';

// Başlık biçimi: "Amazon Prime (Game, PC) - Oyun Adı"
const parseAtom = (xml) => [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
  const e = m[1];
  const rawTitle = decode(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const t = rawTitle.match(/^(.+?)\s\(([^)]*)\)\s-\s(.+)$/);
  const until = e.match(/Offer valid to:(?:<\/b>|&lt;\/b&gt;)\s*([^<&]+)/i)?.[1]?.trim();
  return {
    id: (e.match(/<id>([^<]*)<\/id>/)?.[1] ?? '').trim(),
    source: (catOf(e, 'source') || t?.[1] || 'Diğer').trim(),
    platform: (catOf(e, 'platform') || t?.[2]?.split(',').pop() || '').trim(),
    type: (catOf(e, 'type') || t?.[2]?.split(',')[0] || '').trim().toLowerCase(),
    title: (t?.[3] ?? rawTitle).trim(),
    url: (e.match(/<link\b[^>]*href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&'),
    published: Date.parse(e.match(/<published>([^<]+)</)?.[1] ?? ''),
    note: until ? `son: ${until}` : '',
    raw: e,
  };
}).filter((x) => x.id && x.url && Number.isFinite(x.published));

async function getLoot() {
  const res = await fetch(LOOT_FEED, { headers: { 'user-agent': UA, accept: 'application/atom+xml, application/xml, text/xml, */*' } });
  if (!res.ok) throw new Error(`LootScraper hata verdi: HTTP ${res.status}`);
  const entries = parseAtom(await res.text());
  if (!entries.length) throw new Error('LootScraper yayınında içerik okunamadı.');

  const items = [];
  for (const x of entries) {
    const src = x.source.toLowerCase();
    if (LOOT_SKIP_SOURCES.has(src)) continue; // Steam ve GOG yukarıda doğrudan kontrol ediliyor
    const mobile = /^(ios|android)$/i.test(x.platform);
    if (src.startsWith('epic') && !mobile) continue; // Epic PC yukarıda zaten var
    if (now - x.published > 7 * DAY) continue;
    const suffix = x.platform && x.platform.toLowerCase() !== 'pc' && !x.title.toLowerCase().endsWith(`(${x.platform.toLowerCase()})`) ? ` (${x.platform})` : '';
    const dlc = x.type === 'loot' ? ' [DLC/oyun içi içerik]' : '';
    items.push({ id: x.id, source: x.source, title: x.title + suffix + dlc, url: x.url, published: new Date(x.published).toISOString(), note: x.note });
  }
  items.sort((a, b) => b.published.localeCompare(a.published));
  return { items, allIds: entries.map((x) => x.id), debug: entries.slice(0, 2).map((x) => x.raw).join('\n-----\n').slice(0, 3000) };
}

// ---------- Legion Gaming Community (Game Key Drops) ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const LEGION_BASE = 'https://gaming.lenovo.com';
const stripTags = (h) => decode(h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' '));

const parseMonthDay = (text) => {
  const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const today = new Date(now);
  let year = today.getUTCFullYear();
  if (Date.UTC(year, month, day) < now - 30 * DAY) year += 1;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
};

const titleFromSlug = (href) => {
  const seg = decodeURIComponent(href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '');
  const words = seg.replace(/---game-key-drops.*$/i, '').replace(/^coming-soon-/i, '').replace(/-key-drops?$/i, '').split('-').filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || seg;
};

async function getLegion() {
  const res = await fetch(`${LEGION_BASE}/game-key-drops`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`Legion sayfası hata verdi: HTTP ${res.status}`);
  const html = await res.text();
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];

  // Tarih ("Free Oct 28th") bağlantıdan önce gelir; bağlantıya en yakın olanı al.
  const dateBefore = (idx) => {
    const text = stripTags(html.slice(Math.max(0, idx - 1200), idx));
    let found = null;
    for (const m of text.matchAll(/free\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})/gi)) found = parseMonthDay(m[1]) ?? found;
    return found;
  };

  const events = [];
  for (const m of anchors) {
    const href = m[1].replace(/&amp;/g, '&');
    const path = href.split(/[?#]/)[0];
    if (!/key-drop/i.test(href) || /\/game-key-drops\/?$/i.test(path)) continue;
    const url = href.startsWith('http') ? href : LEGION_BASE + (href.startsWith('/') ? '' : '/') + href;
    const label = stripTags(m[2]).replace(/^[^\p{L}\p{N}]+/u, ''); // baştaki emojiyi at
    if (/\bended\b/i.test(label) || /ended/i.test(path)) continue; // bitmiş drop'lar bildirilmesin
    const date = dateBefore(m.index);
    const known = events.find((e) => e.url === url);
    if (known) { known.date ??= date; continue; } // aynı bağlantı yan menüde de geçer; tarihi sonraki geçişten tamamla
    const title = label && !/^(learn more|read more|more|join|details?)$/i.test(label) ? label : titleFromSlug(href);
    events.push({ title, url, date });
  }
  const debug = `anchor sayısı: ${anchors.length}\nbağlantılar:\n${anchors.map((a) => a[1]).slice(0, 60).join('\n')}\n\nmetin:\n${stripTags(html).slice(0, 2500)}`;
  if (!events.length) throw Object.assign(new Error(`Legion etkinlikleri bulunamadı (anchor sayısı: ${anchors.length}).`), { debug });
  return { events, debug };
}

// ---------- Fab hatırlatması ----------
// Fab sayfası GitHub sunucularından gelen istekleri engellediği için okunmaz; bunun yerine,
// iki haftada bir salı günü (10:00 ET) yenilenen ücretsiz içerikler için hatırlatma gönderilir.
const FAB_ANCHOR = Date.UTC(2026, 9, 20); // 20 Ekim 2026: bir Fab yenilenme günü
const todayUtc = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
const fabDaysSince = Math.round((todayUtc - FAB_ANCHOR) / 86400000);
const fabDropDay = fabDaysSince >= 0 && fabDaysSince % 14 === 0;
const fabDropKey = new Date(todayUtc).toISOString().slice(0, 10);

// ---------- Bildirimler ----------
const attempt = async (name, fn) => {
  try {
    await fn();
    console.log(`Bildirim gönderildi: ${name}`);
  } catch (e) {
    console.warn(`Bildirim gönderilemedi (${name}): ${e.message}`);
  }
};
const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
};

async function notify({ title, plain, links }) {
  if (process.env.NTFY_TOPIC) {
    await attempt('ntfy (telefon)', () => post(process.env.NTFY_SERVER || 'https://ntfy.sh', {
      topic: process.env.NTFY_TOPIC,
      title,
      message: plain,
      priority: 4,
      tags: ['video_game'],
      click: links[0]?.url,
      actions: links.slice(0, 3).map((l) => ({ action: 'view', label: l.label.slice(0, 30), url: l.url })),
    }));
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    await attempt('Discord', () => post(process.env.DISCORD_WEBHOOK_URL, { content: `${title}\n\n${plain}`.slice(0, 1900) }));
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await attempt('Telegram', () => post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: `${title}\n\n${plain}`,
    }));
  }
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    await attempt('GitHub Issue', async () => {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
        body: JSON.stringify({ title, body: plain }),
      });
      if (r.status === 410 || r.status === 404) throw new Error('Bu depoda Issues kapalı (Settings > Features > Issues).');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });
  }
}

// ---------- Ana akış ----------
if (process.env.NOTIFY_TEST === '1') {
  await notify({
    title: 'Test bildirimi',
    plain: 'Epic/Fab ücretsiz oyun takibi çalışıyor. Yeni bir ücretsiz oyun çıkınca böyle bir bildirim alacaksın.',
    links: [{ label: 'Epic ücretsiz oyunlar', url: EPIC_FALLBACK_URL }],
  });
  process.exit(0);
}

let previous = {};
try {
  previous = JSON.parse(await readFile(`${OUT_DIR}/latest.json`, 'utf8'));
} catch { /* ilk çalıştırma */ }
const previousEpicKey = previous.epic?.key ?? previous.key ?? null; // eski dosya biçimiyle uyumlu
const previousSteamIds = new Set((previous.steam?.items ?? []).map((i) => i.id));
const previousGogIds = new Set((previous.gog?.items ?? []).map((i) => i.id));
const previousLootSeen = new Set(previous.lootscraper?.seen ?? []);
const previousLegionUrls = new Set((previous.legion?.events ?? []).map((e) => e.url));
const previousLegionReminded = new Set(previous.legion?.reminded ?? []);
const previousFabReminder = previous.fabReminder ?? null;

const errors = [];
const epic = await getEpic().catch((e) => { errors.push(`Epic: ${e.message}`); return null; });
const steam = await getSteam().catch((e) => { errors.push(`Steam: ${e.message}`); return null; });
const gog = await getGog().catch((e) => { errors.push(`GOG: ${e.message}`); return null; });
const loot = await getLoot().catch((e) => { errors.push(`LootScraper: ${e.message}`); return null; });
let legionDebug = '';
const legion = await getLegion().catch((e) => { errors.push(`Legion: ${e.message}`); legionDebug = e.debug ?? ''; return null; });
errors.forEach((e) => console.warn(`UYARI ${e}`));
if (!epic) throw new Error('Hiçbir kaynaktan veri alınamadı.');

const nextFabDay = new Date(FAB_ANCHOR + Math.ceil(Math.max(fabDaysSince, 0) / 14) * 14 * 86400000).toISOString().slice(0, 10);

const lines = [
  '# Ücretsiz oyunlar ve içerikler',
  '',
  `Son kontrol: ${fmt(new Date(now).toISOString())} (İstanbul saati)`,
  '',
  '## Epic Games Store — şu an ücretsiz',
  '',
  ...(epic
    ? (epic.current.length ? epic.current.map((g) => `- [${g.title}](${g.url}) — ${fmt(g.endsAt)} tarihine kadar`) : ['- Şu an ücretsiz oyun görünmüyor.'])
    : ['- Veri alınamadı.']),
  '',
  '## Epic Games Store — sıradaki',
  '',
  ...(epic?.upcoming.length ? epic.upcoming.map((g) => `- ${g.title} — ${fmt(g.startsAt)} tarihinde başlıyor`) : ['- Duyurulmuş bir sonraki oyun yok.']),
  '',
  '## Steam — kalıcı ücretsiz (%100 indirim)',
  '',
  ...(steam
    ? (steam.items.length ? steam.items.map((i) => `- [${i.title}](${i.url})`) : ['- Şu an kalıcı ücretsiz oyun görünmüyor.'])
    : [`- Veri alınamadı (${errors.find((e) => e.startsWith('Steam:')) ?? 'bilinmeyen hata'}).`]),
  '',
  '## GOG — bedava (indirimle)',
  '',
  ...(gog
    ? (gog.items.length ? gog.items.map((i) => `- [${i.title}](${i.url})`) : ['- Şu an bedava oyun görünmüyor.'])
    : [`- Veri alınamadı (${errors.find((e) => e.startsWith('GOG:')) ?? 'bilinmeyen hata'}).`]),
  '',
  '## Diğer platformlar (Prime Gaming, Humble, Play Store, Fab, Epic mobil) — son 7 gün',
  '',
  ...(loot
    ? (loot.items.length ? loot.items.map((i) => `- ${i.source}: [${i.title}](${i.url})${i.note ? ` — ${i.note}` : ''}`) : ['- Yeni bir şey görünmüyor.'])
    : [`- Veri alınamadı (${errors.find((e) => e.startsWith('LootScraper:')) ?? 'bilinmeyen hata'}).`]),
  '',
  'Kaynak: [LootScraper](https://github.com/eikowagenknecht/lootscraper)',
  '',
  '## Legion Gaming Community — Game Key Drops',
  '',
  ...(legion
    ? legion.events.map((e) => `- [${e.title}](${e.url})${e.date ? ` — ${e.date}` : ' — tarih okunamadı'}`)
    : [`- Veri alınamadı (${errors.find((e) => e.startsWith('Legion:')) ?? 'bilinmeyen hata'}).`]),
  '',
  '## Fab',
  '',
  `- İki haftada bir salı günü yenilenir, [ücretsiz içerikler](${FAB_URL}). Oyun adları yukarıdaki bölümde görünür.`,
  '',
];
const markdown = lines.join('\n');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify({
  epic: epic ?? previous.epic ?? null,
  steam: steam ?? previous.steam ?? null,
  gog: gog ?? previous.gog ?? null,
  lootscraper: loot ? { seen: [...new Set([...loot.allIds, ...previousLootSeen])].slice(0, 600), items: loot.items } : previous.lootscraper ?? null,
  legion: legion ? { events: legion.events, reminded: [...previousLegionReminded] } : previous.legion ?? null,
  fabReminder: previousFabReminder,
}, null, 2) + '\n');
await writeFile(`${OUT_DIR}/latest.md`, markdown);

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });

if (epic?.current.length && epic.key !== previousEpicKey) {
  await notify({
    title: `Epic'te ücretsiz: ${epic.current.map((g) => g.title).join(', ')}`,
    plain: [
      ...epic.current.map((g) => `• ${g.title}\n  ${g.url}\n  Son gün: ${fmt(g.endsAt)}`),
      '',
      'Hesabına eklemek için bağlantıya tıklayıp "Edinin" demen yeterli.',
    ].join('\n'),
    links: epic.current.map((g) => ({ label: g.title, url: g.url })),
  });
} else {
  console.log('Epic: bildirim gerekmiyor.');
}

const newSteam = steam?.items.filter((i) => !previousSteamIds.has(i.id)) ?? [];
if (newSteam.length) {
  await notify({
    title: `Steam'de kalıcı ücretsiz: ${newSteam.map((i) => i.title).join(', ')}`,
    plain: [
      ...newSteam.map((i) => `• ${i.title}\n  ${i.url}`),
      '',
      'Kütüphanene kalıcı eklemek için sayfada "Kütüphaneme Ekle" de. Süre sınırlı olabilir.',
    ].join('\n'),
    links: newSteam.map((i) => ({ label: i.title, url: i.url })),
  });
} else {
  console.log('Steam: bildirim gerekmiyor.');
}

const newGog = gog?.items.filter((i) => !previousGogIds.has(i.id)) ?? [];
if (newGog.length) {
  await notify({
    title: `GOG'da bedava: ${newGog.map((i) => i.title).join(', ')}`,
    plain: [
      ...newGog.map((i) => `• ${i.title}\n  ${i.url}`),
      '',
      'Hesabına eklemek için sayfada sepete ekleyip ücretsiz satın al. Süre sınırlı olabilir.',
    ].join('\n'),
    links: newGog.map((i) => ({ label: i.title, url: i.url })),
  });
} else {
  console.log('GOG: bildirim gerekmiyor.');
}

// LootScraper: yeni çıkanlar, kaynak başına tek bildirim
if (loot) {
  const firstRun = !previous.lootscraper;
  const fresh = loot.items.filter((i) => (firstRun ? now - Date.parse(i.published) < 2 * DAY : !previousLootSeen.has(i.id)));
  const bySource = Map.groupBy ? Map.groupBy(fresh, (i) => i.source) : fresh.reduce((m, i) => m.set(i.source, [...(m.get(i.source) ?? []), i]), new Map());
  for (const [source, list] of bySource) {
    await notify({
      title: `${source}'da ücretsiz: ${list.map((i) => i.title).join(', ')}`.slice(0, 200),
      plain: [...list.map((i) => `• ${i.title}\n  ${i.url}${i.note ? `\n  ${i.note}` : ''}`), '', 'Süre sınırlı olabilir, erken al.'].join('\n'),
      links: list.map((i) => ({ label: i.title, url: i.url })),
    });
  }
  if (!fresh.length) console.log('LootScraper: bildirim gerekmiyor.');
}

// Legion: yeni etkinlik ve etkinlik günü hatırlatması
if (legion) {
  const today = new Date(now).toISOString().slice(0, 10);
  const firstRun = !previous.legion;
  const reminded = new Set(previousLegionReminded);
  let changed = false;
  for (const ev of legion.events) {
    if (ev.date && ev.date < today) continue;
    const prep = 'Hazırlık: ücretsiz Legion Gaming Community hesabı + doğrulanmış e-postalı Twitch hesabı (son etkinlikte Gamesplanet hesabı da gerekiyordu). Anahtarlar dakikalar içinde tükenebilir, saat sayfada yazmıyor; son etkinlikte 12:00 ET idi.';
    if (!previousLegionUrls.has(ev.url) || (firstRun && !previousLegionUrls.size)) {
      await notify({
        title: `Legion bedava oyun etkinliği: ${ev.title}${ev.date ? ` (${ev.date})` : ''}`,
        plain: `${ev.title}${ev.date ? ` — ${ev.date}` : ''}\n${ev.url}\n\n${prep}`,
        links: [{ label: ev.title, url: ev.url }],
      });
    }
    const rkey = `${ev.url}@${ev.date}`;
    if (ev.date === today && new Date(now).getUTCHours() >= 14 && !reminded.has(rkey)) {
      await notify({
        title: `Legion etkinliği bugün: ${ev.title}`,
        plain: `Bugün başlıyor olabilir: ${ev.title}\n${ev.url}\n\n${prep}`,
        links: [{ label: ev.title, url: ev.url }],
      });
      reminded.add(rkey);
      changed = true;
    }
  }
  if (changed) {
    const state = JSON.parse(await readFile(`${OUT_DIR}/latest.json`, 'utf8'));
    state.legion = { ...(state.legion ?? {}), reminded: [...reminded] };
    await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify(state, null, 2) + '\n');
  }
}

if (fabDropDay && !loot && previousFabReminder !== fabDropKey) {
  await notify({
    title: "Fab'da yeni ücretsiz içerikler çıkmış olabilir",
    plain: [
      "Fab'daki ücretsiz içerikler iki haftada bir yenilenir. Süre bitmeden bakmak için:",
      FAB_URL,
      '',
      'Hesabına eklemek için içeriğe girip "Add to My Library" de.',
    ].join('\n'),
    links: [{ label: "Fab ücretsiz içerikler", url: FAB_URL }],
  });
  const state = JSON.parse(await readFile(`${OUT_DIR}/latest.json`, 'utf8'));
  state.fabReminder = fabDropKey;
  await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify(state, null, 2) + '\n');
} else {
  console.log('Fab: hatırlatma günü değil.');
}
