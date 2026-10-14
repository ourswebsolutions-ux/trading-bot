import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @tradepilot/shared ships TypeScript source, so it must be bundled rather than required at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['@tradepilot/shared'] })],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@tradepilot/shared'] })],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { minify: 'esbuild', rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    plugins: [react()]
  }
})
