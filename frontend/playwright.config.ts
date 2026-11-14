import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from './tests/setup/blf611-fixture'

// ── 自包含 fixture spec 回归：运行时中和冲突的 .env.local（必须在 webServer 启动前生效）──
// 问题（Tia review 复现 + 本地根因确认）：Next dev/start 会加载 frontend/.env.local 且其值
// 覆盖 webServer.env。若开发者本机 .env.local 含生产 NEXTAUTH_URL / BACKEND_API_BASE_URL，
// proxy.ts 中间件会（a）把登录重定向到生产域、（b）拿伪造 session 去生产后端 /auth/me 校验
// 被拒 → /dashboard 全部重定向到 /login，自包含 spec 全挂。
//
// 实测根因（BLF-1393 复核，修正了「secret 不一致」的旧判断）：**致命变量是 NEXTAUTH_URL 的
// scheme，不是 NEXTAUTH_SECRET**。webServer.env 的 NEXTAUTH_SECRET 优先级高于 .env.local；
// 但 NEXTAUTH_URL 为 https 时 Auth.js 改用 __Secure- / __Host- 前缀的 cookie 名，而 fixture
// 只种 plain `authjs.session-token`（tests/setup/blf611-fixture.ts）→ 中间件读不到会话 →
// /dashboard 307 跳到生产登录域。故 .env.local 里的 NEXTAUTH_URL 同样必须被中和。
//
// 解法：仅在本次运行目标包含自包含 fixture spec（手机端回归系列 / 跨境电商合规页）时，
// 临时把 .env.local 替换为 fixture-only 内容（备份原文件，退出/中断时还原）；不污染其他
// spec（motion/a11y 等依赖真实后端的用例不受影响）。
// 多会话并行时允许每个 Playwright 运行指定专属端口；默认保持 3200。
const PLAYWRIGHT_PORT = process.env.PLAYWRIGHT_PORT || '3200'
const LOCAL_AUTH_URL = `http://localhost:${PLAYWRIGHT_PORT}`
const ENV_FILE = path.join(__dirname, '.env.local')
const runsSelfContainedSpec = process.argv.some(
  (arg) =>
    arg.includes('ad-mobile-blf611') ||
    arg.includes('ops-mobile-blf613') ||
    arg.includes('@mobile-blf611') ||
    arg.includes('@mobile-blf613') ||
    arg.includes('operations-mobile-blf614') ||
    arg.includes('@mobile-blf614') ||
    arg.includes('operations-mobile-blf615') ||
    arg.includes('@mobile-blf615') ||
    arg.includes('reports-mobile-blf617') ||
    arg.includes('@mobile-blf617') ||
    arg.includes('crm-mobile-blf618') ||
    arg.includes('@mobile-blf618') ||
    arg.includes('crm-keyboard-blf1508') ||
    arg.includes('@mobile-blf1508') ||
    arg.includes('reports-mobile-blf616') ||
    arg.includes('@mobile-blf616') ||
    arg.includes('system-mobile-blf620') ||
    arg.includes('@mobile-blf620') ||
    // 工具与文档页面（BLF-1511）
    arg.includes('tools-mobile-blf1511') ||
    arg.includes('@blf-1511') ||
    arg.includes('ai-mobile-blf1510') ||
    arg.includes('@mobile-blf1510') ||
    // CRM mock 用例：依赖 MockCrmClient 的 localStorage 数据
    arg.includes('crm/lead-to-customer') ||
    arg.includes('crm/sea-flow') ||
    // 跨境电商合规页（BLF-1393）：非 mobile-only，但同样用 fixture 伪造 session + mock 后端
    arg.includes('cross-border-compliance') ||
    arg.includes('warm-ledger-c2-matrix') ||
    arg.includes('warm-ledger-c3-matrix') ||
    arg.includes('warm-ledger-expansion-desktop') ||
    arg.includes('warm-ledger-phone-shell')
)
let envFileBackup: string | null = null
let envFileExisted = false

if (runsSelfContainedSpec) {
  envFileExisted = fs.existsSync(ENV_FILE)
  if (envFileExisted) envFileBackup = fs.readFileSync(ENV_FILE, 'utf8')
  fs.writeFileSync(
    ENV_FILE,
    `# TEMPORARILY REPLACED by playwright (self-contained fixture specs) — restored on exit.\nAUTH_SECRET=${BLF611_FIXTURE_SECRET}\nNEXTAUTH_SECRET=${BLF611_FIXTURE_SECRET}\nAUTH_URL=${LOCAL_AUTH_URL}\nNEXTAUTH_URL=${LOCAL_AUTH_URL}\nNEXT_PUBLIC_CRM_API_MODE=mock\n`
  )
  const restoreEnvFile = () => {
    if (envFileBackup !== null) {
      fs.writeFileSync(ENV_FILE, envFileBackup)
      envFileBackup = null
      return
    }
    if (!envFileExisted && fs.existsSync(ENV_FILE)) {
      fs.unlinkSync(ENV_FILE)
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

const webServerEnv = {
  NEXTAUTH_SECRET: BLF611_FIXTURE_SECRET,
  ...(runsSelfContainedSpec
    ? {
        AUTH_SECRET: BLF611_FIXTURE_SECRET,
        AUTH_URL: LOCAL_AUTH_URL,
        NEXTAUTH_URL: LOCAL_AUTH_URL,
      }
    : {}),
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  use: {
    baseURL: `http://localhost:${PLAYWRIGHT_PORT}`,
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
        url: `http://localhost:${PLAYWRIGHT_PORT}`,
        reuseExistingServer: false,
        timeout: 120 * 1000,
        env: webServerEnv,
      }
    : {
        command: `pnpm dev -p ${PLAYWRIGHT_PORT}`,
        url: `http://localhost:${PLAYWRIGHT_PORT}`,
        reuseExistingServer: !runsSelfContainedSpec,
        timeout: 120 * 1000,
        env: webServerEnv,
      },
})
