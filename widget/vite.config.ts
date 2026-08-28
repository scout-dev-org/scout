import { defineConfig } from 'vite';

/**
 * The widget ships in two pieces.
 *
 * `core` is what every visitor of a host page downloads: the button, the panel and the report flow.
 * `vendor` is the screenshot and recording libraries, four fifths of the former single bundle, which
 * are fetched from the same directory at the moment they are first needed. The core stays an IIFE
 * because host pages embed it with a plain `<script async src>`; the vendor pieces are modules,
 * loaded by native dynamic import.
 */
const target = process.env.SCOUT_WIDGET_TARGET ?? 'core';

export default defineConfig(
  target === 'vendor'
    ? {
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          minify: 'esbuild',
          lib: {
            entry: {
              'scout-screenshot': 'src/vendor/screenshot.ts',
              'scout-recorder': 'src/vendor/recorder.ts',
            },
            formats: ['es'],
          },
          rollupOptions: { output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' } },
        },
      }
    : {
        publicDir: 'public',
        build: {
          lib: {
            entry: 'src/index.ts',
            name: 'ScoutWidget',
            formats: ['iife'],
            fileName: () => 'scout-widget.js',
          },
          outDir: 'dist',
          copyPublicDir: true,
        },
      },
);
