import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const FEEDS = [
  'https://sneakernews.com/feed/',
  'https://nicekicks.com/feed/',
];

const NEWS_PATH = new URL('../src/data/news.json', import.meta.url);
const DROPS_PATH = new URL('../src/data/drops.json', import.meta.url);
const WEEKDAYS_ES = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });

async function fetchLatestItems() {
  const parser = new Parser();
  const items = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 8)) {
        items.push({
          title: item.title ?? '',
          link: item.link ?? '',
          snippet: (item.contentSnippet ?? '').slice(0, 700),
          source: feed.title ?? new URL(feedUrl).hostname,
          date: item.isoDate ?? item.pubDate ?? '',
        });
      }
    } catch (err) {
      console.error(`No se pudo leer ${feedUrl}:`, err.message);
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, 10);
}

function buildPrompt(items, todayISO) {
  const listado = items
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n${it.snippet}\nEnlace: ${it.link}`)
    .join('\n\n');

  return `Eres el redactor de "La Cola", una web española de noticias sobre sneakers y streetwear. Hoy es ${todayISO}.

Te paso ${items.length} noticias reales recogidas hoy de varias fuentes en inglés. Tienes dos tareas:

TAREA 1 — Noticias:
Elige la más relevante como destacada ("feature") y hasta 3 más como secundarias ("side"). Redacta cada titular y resumen en ESPAÑOL, con tus propias palabras — nunca traduzcas ni copies frases literales de la fuente. Menciona de forma natural qué medio lo cuenta.

TAREA 2 — Calendario de lanzamientos:
Revisa las mismas noticias y busca SOLO las que mencionen una fecha de lanzamiento concreta y futura (posterior a hoy). Por cada una (máximo 5), extrae isoDate (YYYY-MM-DD), model, time (o "Por confirmar" si no se menciona), price (o "Por confirmar" si no se menciona) y url. IMPORTANTE: no inventes ninguna fecha, hora ni precio que no esté explícitamente en el texto. Si un artículo no da fecha concreta, no lo incluyas.

Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional, con esta forma exacta:

{
  "feature": { "topic": "string corta", "title": "string", "excerpt": "string", "url": "string" },
  "side": [ { "topic": "string corta", "title": "string", "url": "string" } ],
  "drops": [ { "isoDate": "YYYY-MM-DD", "model": "string", "time": "string", "price": "string", "url": "string" } ]
}

Noticias de origen:

${listado}`;
}

async function generateWithClaude(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta la variable ANTHROPIC_API_KEY');
  const todayISO = new Date().toISOString().slice(0, 10);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      messages: [{ role: 'user', content: buildPrompt(items, todayISO) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Error de la API de Anthropic: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
  const clean = text.replace(/^```json\s*|\s*```$/g, '');
  return JSON.parse(clean);
}

function formatDrops(rawDrops) {
  const today = new Date();
  return rawDrops
    .filter((d) => d.isoDate && new Date(d.isoDate) >= today)
    .sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate))
    .slice(0, 5)
    .map((d) => {
      const dateObj = new Date(d.isoDate + 'T00:00:00');
      const day = WEEKDAYS_ES.format(dateObj);
      const [, month, dayNum] = d.isoDate.split('-');
      return {
        day: day.charAt(0).toUpperCase() + day.slice(1),
        date: `${dayNum}.${month}`,
        model: d.model,
        time: d.time || 'Por confirmar',
        price: d.price || 'Por confirmar',
      };
    });
}

async function main() {
  const items = await fetchLatestItems();
  if (items.length === 0) {
    console.log('No se han encontrado noticias nuevas, no se toca nada.');
    return;
  }
  const result = await generateWithClaude(items);

  await fs.writeFile(
    NEWS_PATH,
    JSON.stringify({ feature: result.feature, side: result.side }, null, 2) + '\n'
  );
  console.log('src/data/news.json actualizado.');

  if (Array.isArray(result.drops)) {
    const drops = formatDrops(result.drops);
    if (drops.length > 0) {
      await fs.writeFile(DROPS_PATH, JSON.stringify(drops, null, 2) + '\n');
      console.log('src/data/drops.json actualizado.');
    } else {
      console.log('No se han encontrado lanzamientos con fecha confirmada.');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
