import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const FEEDS = [
  'https://sneakernews.com/feed/',
  'https://nicekicks.com/feed/',
];

const NEWS_PATH = new URL('../src/data/news.json', import.meta.url);

async function fetchLatestItems() {
  const parser = new Parser();
  const items = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 6)) {
        items.push({
          title: item.title ?? '',
          link: item.link ?? '',
          snippet: (item.contentSnippet ?? '').slice(0, 600),
          source: feed.title ?? new URL(feedUrl).hostname,
          date: item.isoDate ?? item.pubDate ?? '',
        });
      }
    } catch (err) {
      console.error(`No se pudo leer ${feedUrl}:`, err.message);
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, 8);
}

function buildPrompt(items) {
  const listado = items
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n${it.snippet}\nEnlace: ${it.link}`)
    .join('\n\n');

  return `Eres el redactor de "La Cola", una web española de noticias sobre sneakers y streetwear.

Te paso ${items.length} noticias reales recogidas hoy de varias fuentes en inglés. Tu trabajo:

1. Elige la noticia más relevante como destacada ("feature") y hasta 3 más como secundarias ("side").
2. Redacta cada titular y resumen en ESPAÑOL, con tus propias palabras — nunca traduzcas ni copies frases literales de la fuente. Menciona de forma natural qué medio lo cuenta (ej: "Según recoge Sneaker News...").
3. El resumen de la noticia destacada debe tener 2-3 frases. Los titulares secundarios, una frase corta cada uno (sin resumen).
4. Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional antes ni después, con esta forma exacta:

{
  "feature": { "topic": "string corta (1-2 palabras, ej: Reventa, Colaboraciones)", "title": "string", "excerpt": "string", "url": "el enlace original de esa noticia" },
  "side": [
    { "topic": "string corta", "title": "string", "url": "el enlace original de esa noticia" }
  ]
}

Noticias de origen:

${listado}`;
}

async function generateWithClaude(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta la variable ANTHROPIC_API_KEY');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: buildPrompt(items) }],
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

async function main() {
  const items = await fetchLatestItems();
  if (items.length === 0) {
    console.log('No se han encontrado noticias nuevas, no se toca nada.');
    return;
  }
  const news = await generateWithClaude(items);
  await fs.writeFile(NEWS_PATH, JSON.stringify(news, null, 2) + '\n');
  console.log('src/data/news.json actualizado.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
