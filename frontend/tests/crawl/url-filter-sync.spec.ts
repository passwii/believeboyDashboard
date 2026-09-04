/**
 * 回归测试 — URL 筛选参数同步（BEL: 静态预渲染页 query 导航 no-op 修复）。
 *
 * 背景：页面把项目/国家/月份等筛选条件同步到 URL search params。
 * Next.js 静态预渲染（build 输出 ○）的页面，生产构建下 `router.replace`
 * 仅改 query 会被当作"同路由 no-op"——URL 不更新、页面无反馈；dev 模式
 * 按需渲染会掩盖问题。修复要求相关页面 `export const dynamic = 'force-dynamic'`
 * （见 lib/hooks/use-url-param.ts 的 JSDoc 说明）。
 *
 * 本测试必须跑在 **生产构建**（pnpm start）上才有意义：
 *   pnpm build && pnpm start   # 或 CI 的 playwright webServer（pnpm start）
 *   pnpm test:ui -- tests/crawl/url-filter-sync.spec.ts
 *
 * 前置：本地后端（BLF 快照）+ backend/.env.test 的 TEST_USER_*。
 */
import { test, expect, type Page } from '@playwright/test'
import * as fs from 'node:fs'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3200'
const AUTH_FILE = 'tests/.auth/user.json'

const TARGET_URL =
  `${BASE_URL}/dashboard/reports/monthly-report/display` +
  '?fromMonth=2025-08&toMonth=2026-07&monthRange=last12m&project=10&country=DE'

async function ensureAuth(page: Page): Promise<void> {
  const context = page.context()
  if (process.env.E2E_REFRESH_AUTH !== '1') {
    try {
      if (fs.existsSync(AUTH_FILE)) {
        const cached = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
        if (cached.cookies) await context.addCookies(cached.cookies)
        const session = await context.request.get(`${BASE_URL}/api/auth/session`)
        const data = (await session.json()) as { user?: { id?: string | number } }
        if (data?.user?.id) return
      }
    } catch {
      /* fall through */
    }
  }
  const email = process.env.TEST_USER_EMAIL
  const password = process.env.TEST_USER_PASSWORD
  if (!email || !password) {
    throw new Error('TEST_USER_EMAIL / TEST_USER_PASSWORD required (backend/.env.test)')
  }
  const csrfResp = await context.request.get(`${BASE_URL}/api/auth/csrf`)
  const csrfToken = ((await csrfResp.json()) as { csrfToken?: string }).csrfToken
  if (!csrfToken) throw new Error(`CSRF fetch failed: ${csrfResp.status()}`)
  const resp = await context.request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    form: { csrfToken, email, password, json: 'true' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  })
  if (resp.status() !== 200 && resp.status() !== 302) {
    throw new Error(`Login failed: ${resp.status()} ${(await resp.text()).slice(0, 300)}`)
  }
  try {
    fs.mkdirSync('tests/.auth', { recursive: true })
    fs.writeFileSync(AUTH_FILE, JSON.stringify(await context.storageState()), 'utf-8')
  } catch {
    /* best-effort */
  }
}

test('月报 display 页切换国家 → URL 与下拉同步更新', async ({ page }) => {
  await ensureAuth(page)
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(1500)

  expect(new URL(page.url()).searchParams.get('country')).toBe('DE')

  const desktopRow = page.locator('.hidden.lg\\:flex').first()
  const countryTrigger = desktopRow.getByRole('combobox').nth(1)
  await countryTrigger.waitFor({ state: 'visible', timeout: 15000 })
  expect((await countryTrigger.innerText()).trim()).toBe('德国站 (DE)')

  await countryTrigger.click()
  await page.getByRole('option', { name: /英国站 \(UK\)/ }).first().click()

  // router.replace 生效后 URL 应更新为 country=UK（prod 构建下静态页会 no-op 卡在 DE）
  await expect(page).toHaveURL(/country=UK/, { timeout: 5000 })
  expect((await countryTrigger.innerText()).trim()).toBe('英国站 (UK)')
})
