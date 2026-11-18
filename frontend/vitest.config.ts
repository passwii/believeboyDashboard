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
    // Vitest 默认按 CPU 数开 worker（CT-ops 32 vCPU / 14 GB，全量会开 32 个
    // jsdom fork，并发跑两轮会直接打满内存）。默认限制 8 个：2026-11-18 实测
    // 全量 406 文件峰值约 3.6 GB / 152s（4 个时约 2 GB / 298s）。不要同时跑
    // 两个全量；需要调整时用 VITEST_MAX_WORKERS 覆盖。
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 8,
    server: {
      deps: {
        // 不预打包 resolvers，确保上面的 zod/v4/core 别名在解析时生效
        inline: ['@hookform/resolvers'],
      },
    },
  },
})
