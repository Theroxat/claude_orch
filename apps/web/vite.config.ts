import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// Light and dark values of --panel (styles.css): the installed window chrome and splash.
const PANEL_LIGHT = '#e3e8e1';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['assets/**/*.{js,css}', 'assets/*-latin-*.woff2', 'offline.html'],
      },
      manifest: {
        name: 'orch',
        short_name: 'orch',
        description: 'Share Claude Code capacity across your team.',
        start_url: '/',
        scope: '/',
        id: '/',
        display: 'standalone',
        theme_color: PANEL_LIGHT,
        background_color: PANEL_LIGHT,
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon-monochrome-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'monochrome',
          },
        ],
      },
    }),
  ],
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/pwa/stub.ts', import.meta.url)) },
  },
});
