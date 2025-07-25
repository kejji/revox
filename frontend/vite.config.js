import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis', // <--- Ceci règle le problème
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
    },
  },
});
