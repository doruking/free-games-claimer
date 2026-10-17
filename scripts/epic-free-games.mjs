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

  const items = [];
  for (const p of data.products) {
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
const previousFabReminder = previous.fabReminder ?? null;

const errors = [];
const epic = await getEpic().catch((e) => { errors.push(`Epic: ${e.message}`); return null; });
const steam = await getSteam().catch((e) => { errors.push(`Steam: ${e.message}`); return null; });
const gog = await getGog().catch((e) => { errors.push(`GOG: ${e.message}`); return null; });
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
  '## Fab',
  '',
  `- İki haftada bir salı günü yenilenir, [ücretsiz içerikler](${FAB_URL}). Bir sonraki hatırlatma günü: ${nextFabDay}.`,
  '',
];
const markdown = lines.join('\n');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify({
  epic: epic ?? previous.epic ?? null,
  steam: steam ?? previous.steam ?? null,
  gog: gog ?? previous.gog ?? null,
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

if (fabDropDay && previousFabReminder !== fabDropKey) {
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
