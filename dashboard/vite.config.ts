import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 10021,
    proxy: {
      '/api': 'http://localhost:10020',
      '/storage': 'http://localhost:10020',
    },
  },
  build: {
    outDir: 'dist',
  },
});
