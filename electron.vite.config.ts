import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // Effect and the OpenCode SDK are bundled, as T3 Code's desktop main bundles its
    // dependencies: one file loads faster than hundreds of package modules. The Claude
    // SDK stays external because it starts the CLI that ships inside its package.
    plugins: [externalizeDepsPlugin({ exclude: ['effect', '@effect/platform-node', '@opencode-ai/sdk'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          inlineDynamicImports: true,
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    server: {
      fs: {
        allow: [resolve('.')],
      },
    },
    build: {
      minify: 'esbuild',
      // Fonts stay files: an inlined data: font would need a looser CSP (no font-src).
      assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
})
