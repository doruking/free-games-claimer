// Epic Games Store'daki ücretsiz oyunları çeker, free-games/ altına yazar ve liste değiştiyse bildirim gönderir.
// Bağımlılık yok: Node 18+ (yerleşik fetch) yeterli. Şifre ya da giriş bilgisi gerektirmez.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const LOCALE = process.env.EPIC_LOCALE || 'tr';
const COUNTRY = process.env.EPIC_COUNTRY || 'TR';
const OUT_DIR = 'free-games';
const API = `https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=${LOCALE}&country=${COUNTRY}&allowCountries=${COUNTRY}`;
const FALLBACK_URL = `https://store.epicgames.com/${LOCALE}/free-games`;

const now = Date.now();

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
  return slug ? `https://store.epicgames.com/${LOCALE}/p/${slug}` : FALLBACK_URL;
};

// Epic'te discountPercentage === 0 "yüzde yüz indirim" (bedava) demektir.
const windowsOf = (el, kind) => (el.promotions?.[kind] ?? [])
  .flatMap((p) => p.promotionalOffers ?? [])
  .filter((o) => o.discountSetting?.discountPercentage === 0)
  .map((o) => ({ start: Date.parse(o.startDate), end: Date.parse(o.endDate) }));

const res = await fetch(API, { headers: { 'user-agent': 'Mozilla/5.0 (free-games-notifier)' } });
if (!res.ok) throw new Error(`Epic API hata verdi: HTTP ${res.status}`);
const json = await res.json();
const elements = json?.data?.Catalog?.searchStore?.elements;
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

const key = current.map((g) => `${g.id}@${g.endsAt}`).sort().join('|');

let previousKey = null;
try {
  previousKey = JSON.parse(await readFile(`${OUT_DIR}/latest.json`, 'utf8')).key;
} catch { /* ilk çalıştırma */ }

const fmt = (iso) => new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'long', timeStyle: 'short' });

const lines = [
  '# Epic Games ücretsiz oyunlar',
  '',
  `Son kontrol: ${fmt(new Date(now).toISOString())} (İstanbul saati)`,
  '',
  '## Şu an ücretsiz',
  '',
  ...(current.length
    ? current.map((g) => `- [${g.title}](${g.url}) — ${fmt(g.endsAt)} tarihine kadar`)
    : ['- Şu an ücretsiz oyun görünmüyor.']),
  '',
  '## Sıradaki',
  '',
  ...(upcoming.length
    ? upcoming.map((g) => `- ${g.title} — ${fmt(g.startsAt)} tarihinde başlıyor`)
    : ['- Duyurulmuş bir sonraki oyun yok.']),
  '',
];
const markdown = lines.join('\n');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/latest.json`, JSON.stringify({ key, current, upcoming }, null, 2) + '\n');
await writeFile(`${OUT_DIR}/latest.md`, markdown);

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });

if (!current.length) {
  console.log('Ücretsiz oyun yok, bildirim gönderilmeyecek.');
  process.exit(0);
}
if (key === previousKey) {
  console.log('Liste değişmedi, bildirim gönderilmeyecek.');
  process.exit(0);
}

// ---- Bildirimler: liste değiştiyse ----
const title = `Epic'te bu hafta ücretsiz: ${current.map((g) => g.title).join(', ')}`;
const plain = [
  title,
  '',
  ...current.map((g) => `• ${g.title}\n  ${g.url}\n  Son gün: ${fmt(g.endsAt)}`),
  '',
  'Hesabına eklemek için bağlantıya tıklayıp "Edinin" demen yeterli.',
].join('\n');

const attempt = async (name, fn) => {
  try {
    await fn();
    console.log(`Bildirim gönderildi: ${name}`);
  } catch (e) {
    console.warn(`Bildirim gönderilemedi (${name}): ${e.message}`);
  }
};

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
};

if (process.env.DISCORD_WEBHOOK_URL) {
  await attempt('Discord', () => post(process.env.DISCORD_WEBHOOK_URL, { content: plain.slice(0, 1900) }));
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  await attempt('Telegram', () => post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: plain,
    disable_web_page_preview: false,
  }));
}
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  await attempt('GitHub Issue', async () => {
    const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title, body: plain }),
    });
    if (r.status === 410 || r.status === 404) throw new Error('Bu depoda Issues kapalı (Settings > Features > Issues).');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
}
