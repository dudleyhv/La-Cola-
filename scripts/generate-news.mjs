import Parser from 'rss-parser';
import fs from 'node:fs/promises';

const FEEDS = [
  'https://sneakernews.com/feed/',
  'https://nicekicks.com/feed/',
  'https://hypebeast.com/footwear/feed',
  'https://sneakerbardetroit.com/feed/',
  'https://sneakerfiles.com/feed/',
  'https://sneakerfreaker.com/rss.xml',
];

const NEWS_PATH = new URL('../src/data/news.json', import.meta.url);
const DROPS_PATH = new URL('../src/data/drops.json', import.meta.url);
const HERO_PATH = new URL('../src/data/hero.json', import.meta.url);
const ARTICULOS_PATH = new URL('../src/data/articulos.json', import.meta.url);

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function extractBodyText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h1|h2|h3|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return text.slice(0, 6000);
}

async function fetchFullText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        referer: 'https://www.google.com/',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const text = extractBodyText(html);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

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
  const seleccionados = items.slice(0, 10);

  for (const item of seleccionados) {
    item.fullText = await fetchFullText(item.link);
  }

  return seleccionados;
}

function buildPrompt(items, todayISO) {
  const listado = items
    .map((it, i) => {
      const texto = it.fullText || it.snippet;
      return `${i + 1}. [${it.source}] ${it.title}\nEnlace: ${it.link}\nTexto disponible:\n"""\n${texto}\n"""`;
    })
    .join('\n\n');

  return `Eres un redactor experto de "Apolo Radar", una web española de noticias sobre sneakers y streetwear, con el mismo nivel de detalle y contexto que un medio especializado como Sole Retriever o Hypebeast. Hoy es ${todayISO}.

Te paso ${items.length} noticias reales recogidas hoy de varias fuentes en inglés, con el texto de su página ya extraído cuando ha sido posible (si no, un resumen corto del feed). Elige la más relevante como destacada ("feature") y hasta 3 más como secundarias ("side"). Para cada una, redacta en ESPAÑOL y con tus propias palabras (nunca traduzcas ni copies frases literales de la fuente). Aprovecha todo el detalle relevante que aparezca en el texto disponible (contexto, colaboraciones o lanzamientos previos mencionados, inspiración del diseño, declaraciones si las hay) — cuanto más rico sea el texto de origen, más se debe desarrollar el artículo:
- "excerpt": un resumen corto de 1-2 frases, para mostrar en las tarjetas de la portada.
- "body": el texto completo de la página individual de la noticia, separado en párrafos con salto de línea doble:
  - Para la noticia "feature": 4-5 párrafos (apertura, contexto/trasfondo, detalles concretos, cierre con la fuente y qué falta por confirmar).
  - Para las noticias "side": 2-3 párrafos (apertura con lo esencial, algo de contexto, y la fuente).
  Si el texto disponible es escaso (solo un resumen corto), escribe menos párrafos en vez de rellenar con paja, pero nunca inventes datos (fechas, precios, cifras, citas) que no estén explícitos en el texto de origen.

El campo "url" de cada elemento debe ser EXACTAMENTE igual a uno de los enlaces que te doy abajo, sin modificarlo.

Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional, con esta forma exacta:

{
  "feature": { "topic": "string corta", "title": "string", "excerpt": "string", "body": "string", "url": "string" },
  "side": [ { "topic": "string corta", "title": "string", "excerpt": "string", "body": "string", "url": "string" } ]
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
      max_tokens: 4200,
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

// Normaliza un titular para poder comparar si dos noticias (aunque vengan de
// fuentes o enlaces distintos) están contando en realidad la misma historia.
function normalizeTitle(title) {
  return title
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadJson(path, fallback) {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildHero(drops, news) {
  if (drops.length > 0) {
    const d = drops[0];
    const storeLabel = d.stores?.length > 0 ? d.stores.join(', ') : 'tienda por confirmar';
    return {
      tag: 'Lanzamiento destacado',
      dateLabel: d.day && d.date ? `${d.day} ${d.date}` : '',
      title: d.model,
      description: `Hora de apertura: ${d.time || 'Por confirmar'} · Precio: ${d.price || 'Por confirmar'}`,
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

  const archive = await loadJson(ARTICULOS_PATH, []);
  const existingSlugs = new Set(archive.map((a) => a.slug));
  const newArticles = [];

  function registerArticle({ type, topic, title, excerpt, body, url, image }) {
    // 1. ¿Ya existe un artículo con este mismo enlace de origen?
    let article = archive.find((a) => a.sourceUrl === url);

    // 2. Si no, ¿ya existe un artículo con el mismo titular (normalizado)?
    //    Esto evita duplicados cuando dos fuentes distintas (o dos tandas
    //    del día) cubren la misma noticia con el mismo título.
    if (!article) {
      const normalizado = normalizeTitle(title);
      article = archive.find((a) => normalizeTitle(a.title) === normalizado);
    }

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
      };
      archive.push(article);
      newArticles.push(article);
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

  const drops = await loadJson(DROPS_PATH, []);
  const hero = buildHero(drops, news);
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
