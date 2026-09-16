# Apolo Radar
Web de noticias y lanzamientos de sneakers/streetwear, construida con [Astro](https://astro.build).
Sitio 100% estático: genera HTML en el `build` y no necesita servidor propio.

## Estructura

```
src/
  data/         ← el contenido del sitio (esto es lo que la automatización irá actualizando)
    hero.json     — el drop destacado de hoy
    drops.json    — calendario de próximos lanzamientos
    news.json     — noticias (una destacada + secundarias)
    resale.json   — tabla de precios de reventa
  pages/
    index.astro   — la página de inicio, lee los JSON de arriba
  styles/
    global.css    — todo el diseño visual
```

## Desarrollo local

Necesitas [Node.js](https://nodejs.org) 18 o superior.

```bash
npm install
npm run dev
```

Abre http://localhost:4321 — se recarga solo al guardar cambios.

## Desplegar en Vercel

1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. Entra en [vercel.com](https://vercel.com), "Add New Project" → importa el repositorio.
3. Vercel detecta Astro automáticamente (framework preset "Astro"), no hace falta tocar nada más.
4. Pulsa "Deploy". En 1–2 minutos tendrás una URL pública (`tu-proyecto.vercel.app`), con dominio propio configurable después desde el panel del proyecto.

Cada vez que hagas `git push`, Vercel vuelve a desplegar automáticamente.

## Nota sobre este prototipo

No he podido ejecutar `npm install` en este entorno de trabajo (no tiene acceso a internet), así que el proyecto no se ha compilado ni probado aquí — pero sigue la estructura estándar de Astro, así que debería instalar y arrancar sin problemas en tu máquina o directamente en Vercel. Si al hacer `npm run dev` o el deploy te sale algún error, pégamelo y lo resolvemos.

Los datos en `src/data/*.json` son de ejemplo (fechas, precios y noticias inventados) — el siguiente paso es montar el script que los sustituya automáticamente por contenido real.
