import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1', strictPort: true, port: 5173,
    watch: { ignored: ['**/release/**', '**/test-results/**', '**/.cache/**'] },
  },
  build: { target: 'chrome130' },
});
