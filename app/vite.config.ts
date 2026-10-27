import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: './', // so the built page loads from file:// in Electron
  server: { port: 5199, strictPort: false },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'] },
});
