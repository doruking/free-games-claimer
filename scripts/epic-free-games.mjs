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

// ---------- Fab (Epic'in içerik mağazası) ----------
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function getFab() {
  const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };
  const res = await fetch(FAB_URL, { headers });
  if (!res.ok) throw new Error(`Fab sayfası hata verdi: HTTP ${res.status}`);
  const html = await res.text();

  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const ids = [...new Set([...html.matchAll(new RegExp(`/listings/(${uuid})`, 'g'))].map((m) => m[1]))];
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const endsText = text.match(/Until\s+([A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2}\s?[AP]M\s?[A-Z]{2,4})/)?.[1] ?? null;

  const items = [];
  for (const id of ids) {
    const url = `https://www.fab.com/listings/${id}`;
    let title = null;
    try {
      const r = await fetch(url, { headers });
      if (r.ok) {
        const page = await r.text();
        const raw = page.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1] ?? page.match(/<title>([^<]+)<\/title>/)?.[1];
        if (raw) title = decode(raw).replace(/\s*\|\s*Fab$/i, '');
      }
    } catch { /* başlık alınamazsa kimlikle devam */ }
    items.push({ id, title: title ?? `Fab içeriği (${id.slice(0, 8)})`, url });
  }
  return { key: items.map((i) => i.id).sort().join('|'), items, endsText, rawLinkCount: ids.length };
}

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
const previousFabKey = previous.fab?.key ?? null;

const errors = [];
const epic = await getEpic().catch((e) => { errors.push(`Epic: ${e.message}`); return null; });
const fab = await getFab().catch((e) => { errors.push(`Fab: ${e.message}`); return null; });
errors.forEach((e) => console.warn(`UYARI ${e}`));
if (!epic && !fab) throw new Error('Hiçbir kaynaktan veri alınamadı.');

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
  `## Fab — şu an ücretsiz${fab?.endsText ? ` (Until ${fab.endsText})` : ''}`,
  '',
  ...(fab
    ? (fab.items.length ? fab.items.map((i) => `- [${i.title}](${i.url})`) : ['- Fab sayfasından içerik okunamadı.'])
    : [`- Veri alınamadı (${errors.find((e) => e.startsWith('Fab:')) ?? 'bilinmeyen hata'}).`]),
  '',
];
const markdown = lines.join('\n');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify({
  epic: epic ?? previous.epic ?? null,
  fab: fab ?? previous.fab ?? null,
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

if (fab?.items.length && fab.key !== previousFabKey) {
  await notify({
    title: `Fab'da ücretsiz: ${fab.items.map((i) => i.title).join(', ')}`,
    plain: [
      ...fab.items.map((i) => `• ${i.title}\n  ${i.url}`),
      '',
      fab.endsText ? `Süre: Until ${fab.endsText}` : 'Süre sınırlı, erken al.',
      'Fab hesabına eklemek için bağlantıya tıklayıp "Add to My Library" de.',
    ].join('\n'),
    links: fab.items.map((i) => ({ label: i.title, url: i.url })),
  });
} else {
  console.log('Fab: bildirim gerekmiyor.');
}
