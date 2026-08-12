import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from './tests/setup/blf611-fixture'

// ── BLF-611 / BLF-613 手机端回归：运行时中和冲突的 .env.local（必须在 webServer 启动前生效）──
// 问题（Tia review 复现 + 本地根因确认）：Next dev/start 会加载 frontend/.env.local 且其值
// 覆盖 webServer.env。若开发者本机 .env.local 含生产 NEXTAUTH_URL / BACKEND_API_BASE_URL，
// proxy.ts 中间件会（a）把登录重定向到生产域、（b）拿伪造 session 去生产后端 /auth/me 校验
// 被拒 → /dashboard 全部重定向到 /login，BLF-611/BLF-613 spec 全挂。
// 解法：仅在本次运行目标包含 mobile 自包含 spec（ad-mobile-blf611 / ops-mobile-blf613）时，
// 临时把 .env.local 替换为 fixture-only 内容（备份原文件，退出/中断时还原）；不污染其他
// spec（motion/a11y 等依赖真实后端的用例不受影响）。
const ENV_FILE = path.join(__dirname, '.env.local')
const runsMobileSpec = process.argv.some(
  (arg) =>
    arg.includes('ad-mobile-blf611') ||
    arg.includes('ops-mobile-blf613') ||
    arg.includes('@mobile-blf611') ||
    arg.includes('@mobile-blf613') ||
    arg.includes('operations-mobile-blf614') ||
    arg.includes('@mobile-blf614')
)
let envFileBackup: string | null = null

if (runsMobileSpec && fs.existsSync(ENV_FILE)) {
  envFileBackup = fs.readFileSync(ENV_FILE, 'utf8')
  fs.writeFileSync(
    ENV_FILE,
    `# TEMPORARILY REPLACED by playwright (mobile self-contained specs) — restored on exit.\nNEXTAUTH_SECRET=${BLF611_FIXTURE_SECRET}\n`
  )
  const restoreEnvFile = () => {
    if (envFileBackup !== null) {
      fs.writeFileSync(ENV_FILE, envFileBackup)
      envFileBackup = null
    }
  }
  process.on('exit', restoreEnvFile)
  process.on('SIGINT', () => {
    restoreEnvFile()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    restoreEnvFile()
    process.exit(143)
  })
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],
  webServer: process.env.CI
    ? {
        command: 'pnpm start',
        url: 'http://localhost:3200',
        reuseExistingServer: false,
        timeout: 120 * 1000,
        env: { NEXTAUTH_SECRET: BLF611_FIXTURE_SECRET },
      }
    : {
        command: 'pnpm dev',
        url: 'http://localhost:3200',
        reuseExistingServer: true,
        timeout: 120 * 1000,
        env: { NEXTAUTH_SECRET: BLF611_FIXTURE_SECRET },
      },
})
