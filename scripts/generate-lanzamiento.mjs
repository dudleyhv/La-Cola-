import fs from 'node:fs/promises';

const DROPS_PATH = new URL('../src/data/drops.json', import.meta.url);
const HERO_PATH = new URL('../src/data/hero.json', import.meta.url);
const NEWS_PATH = new URL('../src/data/news.json', import.meta.url);
const ARTICULOS_PATH = new URL('../src/data/articulos.json', import.meta.url);
const WEEKDAYS_ES = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });
const MAX_DROPS = 8;

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

async function loadJson(path, fallback) {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function extractMeta(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    'i'
  );
  const match = html.match(re);
  return match ? decodeEntities(match[1]) : null;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeEntities(match[1]).trim() : null;
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
  return text.slice(0, 8000);
}

async function fetchArticle(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      referer: 'https://www.google.com/',
      'upgrade-insecure-requests': '1',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-dest': 'document',
    },
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        `No se pudo descargar ${url}: HTTP 403. Esta web bloquea las peticiones automáticas (algo habitual en tiendas oficiales como Nike, Timberland, Zara, etc.). Prueba a pegar en su lugar el enlace a un ARTÍCULO que hable de este lanzamiento (por ejemplo de Hypebeast, Highsnobiety, Sneaker News o similar) en vez del enlace a la ficha de producto de la tienda.`
      );
    }
    throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
  }
  const html = await response.text();
  return {
    title: extractMeta(html, 'og:title') || extractTitle(html) || url,
    image: extractMeta(html, 'og:image'),
    description: extractMeta(html, 'og:description') || extractMeta(html, 'description') || '',
    bodyText: extractBodyText(html),
  };
}

function buildPrompt(url, articulo, todayISO) {
  return `Eres el redactor de "Apolo Radar", una web española de noticias sobre sneakers y streetwear. Hoy es ${todayISO}.

El equipo ha elegido a mano este lanzamiento/colaboración para destacarlo en la sección "Lanzamientos" de la web (no es una selección automática). Te paso el contenido extraído de la página original en inglés (o en otro idioma):

Título original: ${articulo.title}
Descripción: ${articulo.description}
Enlace: ${url}

Texto de la página:
"""
${articulo.bodyText}
"""

Redacta en ESPAÑOL y con tus propias palabras (nunca traduzcas ni copies frases literales de la fuente):
- "topic": una etiqueta corta (ej. "Colaboraciones", "Nuevo lanzamiento").
- "model": el nombre corto del lanzamiento tal y como debería aparecer en una tarjeta (marca + modelo/colaboración).
- "excerpt": un resumen de 1-2 frases para las tarjetas.
- "body": el texto completo de la página individual, con 2-3 párrafos separados por salto de línea doble, desarrollando el contexto y mencionando de forma natural la fuente. No inventes ningún dato (fecha, precio, tienda) que no esté explícito en el texto de origen.
- "isoDate": SOLO si el texto menciona una fecha de lanzamiento concreta (YYYY-MM-DD); si no, usa null.
- "time": SOLO si se menciona una hora concreta; si no, usa null.
- "price": SOLO si se menciona un precio concreto; si no, usa null.
- "stores": array con tiendas mencionadas explícitamente; si no se menciona ninguna, usa [].

Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional, con esta forma exacta:
{ "topic": "string", "model": "string", "excerpt": "string", "body": "string", "isoDate": "YYYY-MM-DD o null", "time": "string o null", "price": "string o null", "stores": ["string"] }`;
}

async function generateWithClaude(url, articulo) {
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
      messages: [{ role: 'user', content: buildPrompt(url, articulo, todayISO) }],
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

function parseUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

async function processUrl(url, archive, existingSlugs, todayISO) {
  console.log(`Descargando y analizando: ${url}`);
  const articulo = await fetchArticle(url);
  const result = await generateWithClaude(url, articulo);

  let entry = archive.find((a) => a.sourceUrl === url);

  let dateFields = {};
  if (result.isoDate) {
    const dateObj = new Date(result.isoDate + 'T00:00:00');
    if (!Number.isNaN(dateObj.getTime())) {
      const day = WEEKDAYS_ES.format(dateObj);
      const [, month, dayNum] = result.isoDate.split('-');
      dateFields = { isoDate: result.isoDate, day: day.charAt(0).toUpperCase() + day.slice(1), date: `${dayNum}.${month}` };
    }
  }
  if (!dateFields.date) {
    dateFields = { isoDate: null, day: '', date: 'Próximamente' };
  }

  if (!entry) {
    const slug = uniqueSlug(slugify(result.model || articulo.title), existingSlugs);
    entry = {
      slug,
      type: 'lanzamiento',
      topic: result.topic || 'Lanzamiento',
      title: result.model,
      excerpt: result.excerpt,
      body: result.body,
      image: articulo.image,
      sourceUrl: url,
      sourceName: new URL(url).hostname.replace(/^www\./, ''),
      publishedAt: todayISO,
      ...dateFields,
      time: result.time || 'Por confirmar',
      price: result.price || 'Por confirmar',
      stores: Array.isArray(result.stores) ? result.stores : [],
    };
    archive.push(entry);
  } else {
    // Ya estaba en la hemeroteca (misma URL): actualizamos su contenido.
    Object.assign(entry, {
      topic: result.topic || entry.topic,
      title: result.model || entry.title,
      excerpt: result.excerpt,
      body: result.body,
      image: articulo.image || entry.image,
      ...dateFields,
      time: result.time || 'Por confirmar',
      price: result.price || 'Por confirmar',
      stores: Array.isArray(result.stores) ? result.stores : entry.stores,
    });
  }

  return {
    day: entry.day,
    date: entry.date,
    model: entry.title,
    time: entry.time,
    price: entry.price,
    stores: entry.stores,
    image: entry.image,
    url: entry.sourceUrl,
    slug: entry.slug,
  };
}

async function main() {
  const raw = (process.env.INPUT_URL || '').trim();
  if (!raw) {
    throw new Error('No se ha recibido ninguna URL. Rellena el campo "url" al ejecutar este workflow.');
  }
  const urls = parseUrls(raw);
  if (urls.length === 0) {
    throw new Error('No se ha reconocido ninguna URL válida en el texto recibido.');
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  const archive = await loadJson(ARTICULOS_PATH, []);
  const existingSlugs = new Set(archive.map((a) => a.slug));

  const dropCards = [];
  const errores = [];

  for (const url of urls) {
    try {
      const dropCard = await processUrl(url, archive, existingSlugs, todayISO);
      dropCards.push(dropCard);
    } catch (err) {
      console.error(err.message || err);
      errores.push({ url, mensaje: err.message || String(err) });
    }
  }

  if (dropCards.length === 0) {
    throw new Error(
      `No se ha podido procesar ninguna de las ${urls.length} URL(s) recibidas:\n` +
        errores.map((e) => `- ${e.url}: ${e.mensaje}`).join('\n')
    );
  }

  await fs.writeFile(ARTICULOS_PATH, JSON.stringify(archive, null, 2) + '\n');
  console.log('src/data/articulos.json actualizado.');

  const drops = await loadJson(DROPS_PATH, []);
  const nuevosSlugs = new Set(dropCards.map((d) => d.slug));
  const withoutThese = drops.filter((d) => !nuevosSlugs.has(d.slug));
  const newDrops = [...dropCards, ...withoutThese].slice(0, MAX_DROPS);
  await fs.writeFile(DROPS_PATH, JSON.stringify(newDrops, null, 2) + '\n');
  console.log('src/data/drops.json actualizado.');

  const news = await loadJson(NEWS_PATH, null);
  const heroCard = dropCards[0];
  const storeLabel = heroCard.stores?.length > 0 ? heroCard.stores.join(', ') : 'tienda por confirmar';
  const hero = {
    tag: 'Lanzamiento destacado',
    dateLabel: heroCard.day && heroCard.date !== 'Próximamente' ? `${heroCard.day} ${heroCard.date}` : '',
    title: heroCard.model,
    description: `Hora de apertura: ${heroCard.time} · Precio: ${heroCard.price}`,
    store: `vía ${storeLabel}`,
    image: heroCard.image,
    ctaText: 'Leer la noticia completa',
    ctaUrl: heroCard.url,
    slug: heroCard.slug,
  };
  await fs.writeFile(HERO_PATH, JSON.stringify(hero, null, 2) + '\n');
  console.log('src/data/hero.json actualizado (el primer lanzamiento de la lista pasa a ser el destacado de portada).');
  void news;

  console.log(`\nProcesados correctamente: ${dropCards.length} de ${urls.length}.`);
  if (errores.length > 0) {
    console.log('Con errores (no se han añadido):');
    for (const e of errores) console.log(`- ${e.url}: ${e.mensaje}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
