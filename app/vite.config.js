import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged app loads index.html from disk (file://), where Chromium refuses
// ES-module and crossorigin scripts. Emit a classic deferred script instead.
const classicScript = {
  name: 'classic-script',
  enforce: 'post',
  transformIndexHtml: (html) => html.replace(/ type="module"/g, ' defer').replace(/ crossorigin/g, ''),
};

export default defineConfig({
  base: './',
  plugins: [react(), classicScript],
  // Real CSS/image/font files (no JS-injected styles, no data: URIs), so the page's CSP can stay strict.
  build: { modulePreload: false, cssCodeSplit: false, assetsInlineLimit: 0, rollupOptions: { output: { format: 'iife' } } },
});
