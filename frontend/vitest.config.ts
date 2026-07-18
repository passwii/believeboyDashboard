import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // @hookform/resolvers@5 解析 zod/v4/core；但 pnpm 把 zod@3 嵌套进
      // resolvers 的 node_modules（chromium-bidi 依赖），导致子路径缺失。
      // 测试环境把该子路径指向实际安装的 zod@4 包。
      'zod/v4/core': fileURLToPath(
        new URL('./node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/index.js', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    server: {
      deps: {
        // 不预打包 resolvers，确保上面的 zod/v4/core 别名在解析时生效
        inline: ['@hookform/resolvers'],
      },
    },
  },
})
