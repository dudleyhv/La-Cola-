import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

// Cuántos días atrás consideramos que un producto es "nuevo".
const DIAS_RECIENTES = 30;
// Cuántos productos como máximo se proponen en una sola ejecución.
const MAX_RESULTADOS = 15;
// Cuántos sitemaps de producto se revisan como máximo por marca (para no hacer
// miles de peticiones si el filtro de abajo no acierta a la primera).
const MAX_SITEMAPS_POR_MARCA = 5;

// Lista de palabras clave de tendencia (acordada con el usuario, sin acentos).
const PALABRAS_CLAVE = [
  'oversized', 'baggy', 'wide leg', 'cargo', 'boxy',
  'chandal', 'track suit', 'bomber', 'parka', 'chaleco', 'vest', 'gilet',
  'camisa tecnica', 'overshirt', 'denim', 'nylon', 'tejido tecnico',
  'pana', 'corduroy', 'fleece', 'borreguito',
  'workwear', 'utility', 'gorpcore', 'y2k', 'skate',
  'multibolsillos', 'cordon', 'drawstring', 'reflectante', 'logo grande', 'branding',
];

// Empezamos solo con Bershka. Para añadir otra marca de Inditex más adelante,
// basta con añadir otro objeto aquí con su propio sitemapIndice.
const MARCAS = [
  {
    nombre: 'Bershka',
    sitemapIndice: 'https://www.bershka.com/sitemap/sitemap_indice.xml.gz',
  },
];

const INDITEX_PATH = new URL('../src/data/inditex.json', import.meta.url);

function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

async function descargarXml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; LaColaBot/1.0; +https://la-cola.vercel.app)',
    },
  });
  if (!res.ok) throw new Error(`No se pudo descargar ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(buf).toString('utf-8');
  } catch {
    return buf.toString('utf-8');
  }
}

function extraerBloques(xml, etiqueta) {
  const re = new RegExp(`<${etiqueta}>([\\s\\S]*?)<\\/${etiqueta}>`, 'g');
  const bloques = [];
  let m;
  while ((m = re.exec(xml))) bloques.push(m[1]);
  return bloques;
}

function extraerEtiqueta(bloque, etiqueta) {
  const m = bloque.match(new RegExp(`<${etiqueta}[^>]*>([\\s\\S]*?)<\\/${etiqueta}>`));
  return m ? m[1].trim() : null;
}

function tituloDesdeUrl(url) {
  try {
    const path = new URL(url).pathname;
    const archivo = path.split('/').pop() ?? '';
    const sinExtension = archivo.replace(/\.html?$/i, '');
    const sinCodigo = sinExtension.replace(/-c\d+$/i, '');
    return sinCodigo.replace(/-/g, ' ').trim();
  } catch {
    return '';
  }
}

async function obtenerProductosDeMarca(marca) {
  console.log(`\n[${marca.nombre}] Descargando índice de sitemaps...`);
  const indiceXml = await descargarXml(marca.sitemapIndice);
  const sitemaps = extraerBloques(indiceXml, 'sitemap')
    .map((b) => extraerEtiqueta(b, 'loc'))
    .filter(Boolean);

  if (sitemaps.length === 0) {
    throw new Error(
      `[${marca.nombre}] El índice de sitemaps no contiene ningún sitemap. Puede que hayan cambiado el formato de su web.`
    );
  }
  console.log(`[${marca.nombre}] ${sitemaps.length} sitemaps encontrados en el índice. Primeros 10:`);
  sitemaps.slice(0, 10).forEach((s) => console.log(`  - ${s}`));

  const sitemapsDeProducto = sitemaps.filter((s) => /product/i.test(s));
  const aRevisar = (sitemapsDeProducto.length > 0 ? sitemapsDeProducto : sitemaps).slice(
    0,
    MAX_SITEMAPS_POR_MARCA
  );
  console.log(
    `[${marca.nombre}] Revisando ${aRevisar.length} sitemap(s) de producto` +
      (sitemapsDeProducto.length === 0
        ? ' (no se detectó ninguno con "product" en el nombre, se revisan los primeros que hay)'
        : '') +
      '.'
  );

  const limiteFecha = Date.now() - DIAS_RECIENTES * 24 * 60 * 60 * 1000;
  const candidatos = [];
  let totalProductosVistos = 0;

  for (const sitemapUrl of aRevisar) {
    let xml;
    try {
      xml = await descargarXml(sitemapUrl);
    } catch (err) {
      console.error(`[${marca.nombre}] No se pudo leer ${sitemapUrl}: ${err.message}`);
      continue;
    }
    const urls = extraerBloques(xml, 'url');
    totalProductosVistos += urls.length;
    console.log(`[${marca.nombre}] ${sitemapUrl}: ${urls.length} productos.`);

    for (const bloque of urls) {
      const loc = extraerEtiqueta(bloque, 'loc');
      const lastmod = extraerEtiqueta(bloque, 'lastmod');
      if (!loc || !lastmod) continue;
      const fecha = new Date(lastmod).getTime();
      if (Number.isNaN(fecha) || fecha < limiteFecha) continue;

      const imagenTitulo = extraerEtiqueta(bloque, 'image:title');
      const imagenLoc = extraerEtiqueta(bloque, 'image:loc');
      const tituloBase = imagenTitulo || tituloDesdeUrl(loc);

      candidatos.push({
        marca: marca.nombre,
        url: loc,
        lastmod,
        titulo: tituloBase,
        imagen: imagenLoc || null,
      });
    }
  }

  if (totalProductosVistos === 0) {
    throw new Error(
      `[${marca.nombre}] No se ha podido leer ningún producto de sus sitemaps. Es posible que hayan cambiado el formato de su web y haya que revisar el script.`
    );
  }

  console.log(
    `[${marca.nombre}] ${candidatos.length} productos actualizados en los últimos ${DIAS_RECIENTES} días (de ${totalProductosVistos} revisados).`
  );
  return candidatos;
}

function coincideConTendencia(titulo) {
  const normalizado = normalizar(titulo);
  return PALABRAS_CLAVE.filter((p) => normalizado.includes(normalizar(p)));
}

async function main() {
  const raw = await fs.readFile(INDITEX_PATH, 'utf-8').catch(() => '[]');
  const existentes = JSON.parse(raw);
  const urlsExistentes = new Set(existentes.map((e) => e.url));

  let nuevos = [];

  for (const marca of MARCAS) {
    const candidatos = await obtenerProductosDeMarca(marca);
    for (const c of candidatos) {
      if (urlsExistentes.has(c.url)) continue;
      const palabras = coincideConTendencia(c.titulo);
      if (palabras.length === 0) continue;
      nuevos.push({
        titulo: c.titulo,
        url: c.url,
        imagen: c.imagen,
        marca: c.marca,
        lastmod: c.lastmod,
        palabrasClave: palabras,
        fechaAlta: new Date().toISOString().slice(0, 10),
      });
    }
  }

  nuevos.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));
  nuevos = nuevos.slice(0, MAX_RESULTADOS);

  console.log(`\n${nuevos.length} productos coinciden con las palabras clave de tendencia.`);

  if (nuevos.length === 0) {
    console.log('No hay productos nuevos que encajen con las tendencias esta vez.');
    return;
  }

  const actualizado = [...nuevos, ...existentes];

  await fs.writeFile(INDITEX_PATH, JSON.stringify(actualizado, null, 2) + '\n');
  console.log('src/data/inditex.json actualizado.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
