import Parser from 'rss-parser';
import fs from 'node:fs/promises';

// Añade aquí las URLs de los feeds RSS de tus Alertas de Google
// (Google Alerts -> crear alerta -> "Mostrar opciones" -> "Enviar por: Feed RSS").
// Ejemplo: 'https://www.google.com/alerts/feeds/00000000000000000/0000000000000000000'
const FEEDS = [
  // 'PEGA_AQUI_TU_FEED_1',
  // 'PEGA_AQUI_TU_FEED_2',
];

const MARCAS_PATH = new URL('../src/data/marcas.json', import.meta.url);

async function fetchLatestItems() {
  if (FEEDS.length === 0) {
    console.log('No hay feeds de Alertas de Google configurados todavía en FEEDS. No se busca nada.');
    return [];
  }
  const parser = new Parser();
  const items = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        items.push({
          title: item.title ?? '',
          link: item.link ?? '',
          snippet: (item.contentSnippet ?? item.content ?? '').slice(0, 500),
          date: item.isoDate ?? item.pubDate ?? '',
        });
      }
    } catch (err) {
      console.error(`No se pudo leer ${feedUrl}:`, err.message);
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, 20);
}

function buildPrompt(items, existingBrands, todayISO) {
  const listado = items
    .map((it, i) => `${i + 1}. ${it.title}\n${it.snippet}\nEnlace: ${it.link}`)
    .join('\n\n');
  const conocidas = existingBrands.map((b) => b.name).join(', ') || 'ninguna todavía';

  return `Eres el redactor de "La Cola", una web española de streetwear. Hoy es ${todayISO}.

Te paso ${items.length} resultados reales de alertas de búsqueda sobre marcas de ropa/streetwear nuevas o emergentes.

Marcas que YA seguimos (no las seleccciones como "nueva", pero si algún resultado trae una novedad real sobre una de ellas -colaboración, nueva colección, tienda, etc.- inclúyela como actualización): ${conocidas}

Tu tarea:
1. Identifica qué resultados hablan de una marca de streetwear/moda urbana genuinamente nueva o emergente. Descarta resultados irrelevantes, marcas ya masivas/conocidas, o contenido que no trate sobre una marca concreta.
2. Para cada marca NUEVA que encuentres (máximo 3 por ejecución), redacta en ESPAÑOL y con tus propias palabras: nombre exacto de la marca y una descripción corta (2-3 frases: qué hacen, qué la hace interesante). Nunca traduzcas ni copies frases literales de la fuente.
3. Para marcas YA CONOCIDAS con novedad real, redacta una frase corta de actualización.

IMPORTANTE: no inventes ningún dato que no esté en el texto de origen. El campo "sourceUrl" debe ser EXACTAMENTE igual a uno de los enlaces de abajo, sin modificarlo. Si no encuentras nada que merezca la pena, devuelve arrays vacíos.

Devuelve EXCLUSIVAMENTE un JSON válido, sin texto adicional, con esta forma exacta:

{
  "nuevas": [ { "name": "string", "description": "string", "sourceUrl": "string" } ],
  "actualizaciones": [ { "name": "string (debe coincidir con el nombre de una marca ya seguida)", "note": "string", "sourceUrl": "string" } ]
}

Resultados de origen:

${listado}`;
}

async function generateWithClaude(items, existingBrands) {
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
      max_tokens: 1400,
      messages: [{ role: 'user', content: buildPrompt(items, existingBrands, todayISO) }],
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

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  const items = await fetchLatestItems();
  if (items.length === 0) {
    console.log('No se han encontrado novedades de marcas, no se toca nada.');
    return;
  }

  const raw = await fs.readFile(MARCAS_PATH, 'utf-8').catch(() => '[]');
  const marcas = JSON.parse(raw);
  const todayISO = new Date().toISOString().slice(0, 10);

  const result = await generateWithClaude(items, marcas);
  let changed = false;

  for (const nueva of result.nuevas ?? []) {
    if (!nueva?.name) continue;
    const slug = slugify(nueva.name);
    if (marcas.some((m) => m.slug === slug)) continue;
    marcas.push({
      slug,
      name: nueva.name,
      description: nueva.description ?? '',
      sourceUrl: nueva.sourceUrl ?? '',
      image: null,
      firstFeatured: todayISO,
      updates: [],
    });
    changed = true;
  }

  for (const act of result.actualizaciones ?? []) {
    if (!act?.name) continue;
    const slug = slugify(act.name);
    const marca = marcas.find((m) => m.slug === slug);
    if (marca && act.note) {
      marca.updates.push({ date: todayISO, note: act.note, sourceUrl: act.sourceUrl ?? '' });
      changed = true;
    }
  }

  if (!changed) {
    console.log('No hay marcas nuevas ni actualizaciones que merezcan la pena esta vez.');
    return;
  }

  await fs.writeFile(MARCAS_PATH, JSON.stringify(marcas, null, 2) + '\n');
  console.log('src/data/marcas.json actualizado.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
