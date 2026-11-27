import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// `HIDEGPT_PERSONAL` decides whether the Claude library is compiled in. Runs from
// source keep it; `pnpm dist` passes 0 unless the builder sets HIDEGPT_PERSONAL=1,
// so a build shared with others carries no Claude code (see scripts/dist.ts).
const define = { __HIDEGPT_PERSONAL__: JSON.stringify(process.env.HIDEGPT_PERSONAL !== '0') }

export default defineConfig({
  main: {
    define,
    // Effect and the OpenCode SDK are bundled, as T3 Code's desktop main bundles its
    // dependencies: one file loads faster than hundreds of package modules. The Claude
    // SDK stays external because it starts the CLI that ships inside its package.
    plugins: [externalizeDepsPlugin({ exclude: ['effect', '@effect/platform-node', '@opencode-ai/sdk'] })],
    // Chunks are named by hash, not by module: `CodexAdapter-….js` in the app's
    // archive would name a vendor (the stealth scan in `pnpm dist` checks).
    build: { rollupOptions: { output: { chunkFileNames: 'chunk-[hash].js' } } },
  },
  preload: {
    define,
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
    define,
    plugins: [react(), tailwindcss()],
    server: {
      fs: {
        allow: [resolve('.')],
      },
    },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
})
