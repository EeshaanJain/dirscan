import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  build: {
    // a local tool: the main chunk is ~720 kB (recharts is already split out and loads on demand)
    chunkSizeWarningLimit: 800,
  },
  server: {
    // `npm run dev` starts the API server separately and proxies to it.
    proxy: { '/api': 'http://127.0.0.1:4174' },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30_000,
  },
})
