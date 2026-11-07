import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @archgraph/ui dev` вика API-то на `archgraph serve` (по подразбиране порт 8790).
export default defineConfig({
  plugins: [react()],
  server: { port: 8791, proxy: { '/api': 'http://127.0.0.1:8790' } },
});
