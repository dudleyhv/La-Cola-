import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const FEEDS = [
  'https://sneakernews.com/feed/',
  'https://nicekicks.com/feed/',
];

const NEWS_PATH = new URL('../src/data/news.json', import.meta.url);
const DROPS_PATH = new URL('../src/data/drops.json', import.meta.url);
const HERO_PATH = new URL('../src/data/hero.json', import.meta.url);
const ARTICULOS_PATH = new URL('../src/data/articulos.json', import.meta.url);
const WEEKDAYS_ES = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });

function extractImage(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  const media = item.mediaContent;
  if (media) {
    const arr = Array.isArray(media) ? media : [media];
    const found = arr.find((m) => m?.$?.url);
    if (found) return found.$.url;
  }
  const html = item.contentEncoded || item.content || '';
  const match = html.match(/<img[^>]+src="([^">]+)"/i);
  return match ? match[1] : null;
}

async function fetchLatestItems() {
  const parser = new Parser({
    customFields: {
      item: [
        ['media:content', 'mediaContent', { keepArray: true }],
        ['content:encoded', 'contentEncoded'],
      ],
    },
  });
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
          image: extractImage(item),
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

  return `Eres el redactor de "Apolo Radar", una web española de noticias sobre sneakers y streetwear. Hoy es ${todayISO}.

Te paso ${items.length} noticias reales recogidas hoy de varias fuentes en inglés. Tienes dos tareas:

TAREA 1 — Noticias:
Elige la más relevante como destacada ("feature") y hasta 3 más como secundarias ("side"). Para cada una, redacta en ESPAÑOL y con tus propias palabras (nunca traduzcas ni copies frases literales de la fuente):
- "excerpt": un resumen corto de 1-2 frases, para mostrar en las tarjetas de la portada.
- "body": el texto completo de la página individual de la noticia, con 2 párrafos separados por un salto de línea doble. Debe desarrollar el contexto (qué se sabe, qué falta por confirmar) y mencionar de forma natural qué medio lo cuenta, sin inventar datos que no estén en el texto de origen.

TAREA 2 — Calendario de lanzamientos:
Revisa las mismas noticias y busca SOLO las que mencionen una fecha de lanzamiento concreta y futura (posterior a hoy). Por cada una (máximo 5), extrae isoDate (YYYY-MM-DD), model, time (o "Por confirmar" si no se menciona), price (o "Por confirmar" si no se menciona), stores (array con los nombres de las tiendas que el artículo mencione explícitamente), y "body" (1-2 párrafos en español describiendo el lanzamiento con el mismo criterio que en la tarea 1). IMPORTANTE: no inventes ninguna fecha, hora, precio ni tienda que no esté explícitamente en el texto. Si un artículo no da fecha concreta, no lo incluyas.

En ambas tareas, el campo "url" de cada elemento debe ser EXACTAMENTE igual a uno de los enlaces que te doy abajo, sin modificarlo.

Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional, con esta forma exacta:

{
  "feature": { "topic": "string corta", "title": "string", "excerpt": "string", "body": "string", "url": "string" },
  "side": [ { "topic": "string corta", "title": "string", "excerpt": "string", "body": "string", "url": "string" } ],
  "drops": [ { "isoDate": "YYYY-MM-DD", "model": "string", "time": "string", "price": "string", "url": "string", "stores": ["string"], "body": "string" } ]
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
      max_tokens: 3000,
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

function findItem(url, items) {
  return items.find((it) => it.link === url);
}

function findImage(url, items) {
  return findItem(url, items)?.image ?? null;
}

function sourceNameFor(url, items) {
  return findItem(url, items)?.source ?? new URL(url).hostname;
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function uniqueSlug(base, existingSlugs) {
  let slug = base;
  let i = 2;
  while (existingSlugs.has(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  existingSlugs.add(slug);
  return slug;
}

async function loadArchive() {
  try {
    const raw = await fs.readFile(ARTICULOS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function formatDrops(rawDrops, items) {
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
        stores: Array.isArray(d.stores) ? d.stores : [],
        image: findImage(d.url, items),
        url: d.url,
        body: d.body || '',
        isoDate: d.isoDate,
      };
    });
}

function buildHero(drops, news) {
  if (drops.length > 0) {
    const d = drops[0];
    const storeLabel = d.stores.length > 0 ? d.stores.join(', ') : 'tienda por confirmar';
    return {
      tag: 'Próximo lanzamiento',
      dateLabel: `${d.day} ${d.date}`,
      title: d.model,
      description: `Hora de apertura: ${d.time} · Precio: ${d.price}`,
      store: `vía ${storeLabel}`,
      image: d.image,
      ctaText: 'Leer la noticia completa',
      ctaUrl: d.url,
      slug: d.slug,
    };
  }
  const f = news.feature;
  return {
    tag: 'Noticia destacada',
    dateLabel: '',
    title: f.title,
    description: f.excerpt,
    store: f.topic,
    image: f.image,
    ctaText: 'Leer la noticia completa',
    ctaUrl: f.url,
    slug: f.slug,
  };
}

async function main() {
  const items = await fetchLatestItems();
  if (items.length === 0) {
    console.log('No se han encontrado noticias nuevas, no se toca nada.');
    return;
  }
  const result = await generateWithClaude(items);
  const todayISO = new Date().toISOString().slice(0, 10);

  const archive = await loadArchive();
  const existingUrls = new Set(archive.map((a) => a.sourceUrl));
  const existingSlugs = new Set(archive.map((a) => a.slug));
  const newArticles = [];

  function registerArticle({ type, topic, title, excerpt, body, url, image, extra = {} }) {
    let article = archive.find((a) => a.sourceUrl === url);
    if (!article) {
      const slug = uniqueSlug(slugify(title), existingSlugs);
      article = {
        slug,
        type,
        topic,
        title,
        excerpt,
        body: body || excerpt,
        image,
        sourceUrl: url,
        sourceName: sourceNameFor(url, items),
        publishedAt: todayISO,
        ...extra,
      };
      archive.push(article);
      newArticles.push(article);
      existingUrls.add(url);
    }
    return article;
  }

  const featureImage = findImage(result.feature.url, items);
  const featureArticle = registerArticle({
    type: 'noticia',
    topic: result.feature.topic,
    title: result.feature.title,
    excerpt: result.feature.excerpt,
    body: result.feature.body,
    url: result.feature.url,
    image: featureImage,
  });

  const sideResults = Array.isArray(result.side) ? result.side : [];
  const sideArticles = sideResults.map((n) =>
    registerArticle({
      type: 'noticia',
      topic: n.topic,
      title: n.title,
      excerpt: n.excerpt,
      body: n.body,
      url: n.url,
      image: findImage(n.url, items),
    })
  );

  const news = {
    feature: { ...result.feature, image: featureImage, slug: featureArticle.slug },
    side: sideResults.map((n, i) => ({ ...n, image: findImage(n.url, items), slug: sideArticles[i].slug })),
  };
  await fs.writeFile(NEWS_PATH, JSON.stringify(news, null, 2) + '\n');
  console.log('src/data/news.json actualizado.');

  const drops = Array.isArray(result.drops) ? formatDrops(result.drops, items) : [];
  const dropsWithSlug = drops.map((d) => {
    const article = registerArticle({
      type: 'lanzamiento',
      topic: 'Lanzamiento',
      title: d.model,
      excerpt: `${d.model} llega el ${d.day} ${d.date}.`,
      body: d.body,
      url: d.url,
      image: d.image,
      extra: {
        isoDate: d.isoDate,
        day: d.day,
        date: d.date,
        time: d.time,
        price: d.price,
        stores: d.stores,
      },
    });
    return { ...d, slug: article.slug };
  });

  if (dropsWithSlug.length > 0) {
    await fs.writeFile(DROPS_PATH, JSON.stringify(dropsWithSlug, null, 2) + '\n');
    console.log('src/data/drops.json actualizado.');
  } else {
    console.log('No se han encontrado lanzamientos con fecha confirmada.');
  }

  const hero = buildHero(dropsWithSlug, news);
  await fs.writeFile(HERO_PATH, JSON.stringify(hero, null, 2) + '\n');
  console.log('src/data/hero.json actualizado.');

  if (newArticles.length > 0) {
    await fs.writeFile(ARTICULOS_PATH, JSON.stringify(archive, null, 2) + '\n');
    console.log(`src/data/articulos.json actualizado (${newArticles.length} artículo(s) nuevo(s)).`);
  } else {
    console.log('No hay artículos nuevos que añadir a la hemeroteca.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
