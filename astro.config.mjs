import { defineConfig } from 'astro/config';

// Sitio estático: Vercel lo detecta automáticamente y no necesita
// ningún adapter mientras no usemos rutas con renderizado en servidor (SSR).
export default defineConfig({
  site: 'https://la-cola.vercel.app',
});
