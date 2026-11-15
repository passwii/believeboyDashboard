import { build } from '../../node_modules/.pnpm/vite@8.1.3_@types+node@20.19.39_jiti@1.21.7/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  resolve: { alias: { '@': root } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'artifacts/blf-1553/draft/dist',
    copyPublicDir: false,
    emptyOutDir: true,
    lib: {
      entry: 'artifacts/blf-1553/draft/entry.tsx',
      formats: ['iife'],
      name: 'BelieveboyDraft',
      fileName: () => 'draft.js',
    },
    minify: false,
  },
})
console.log('BUILD OK')
