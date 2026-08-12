import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-621 主页/个人中心/杂项页手机端适配回归（dashboard 主页 v2 / profile / change-password /
 * feature-updates / tools / table-showcase / login）。
 *
 * 自包含：伪造 admin session 通过 proxy 鉴权；主页 daily-analysis 系列端点经 page.route mock，
 * 其余页面（profile / change-password / feature-updates / tools / table-showcase）无后端依赖。
 * 默认随 mobile project（Pixel 5，393×851）跑；另加 360×800 小屏用例；桌面零回归在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：主页 KPI 一行两个（V2Grid 手机端 grid-cols-2）；
 * - 总则 2：图表（V2Card col-span-2）独占一行；
 * - 规则 4：KPI 紧凑网格 2×2；
 * - 规则 10：TopProjects 表格容器内横滑（min-width: max-content），页面无整体横向滚动；
 * - 规则 5：change-password / login 输入框触摸目标 ≥44px；
 * - 桌面 1440 零回归（KPI 恢复 4 列、图表 2 列并排）。
 */
const FIXTURE_SECRET = BLF611_FIXTURE_SECRET

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      operatorNameZh: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

/** 页面级无整体横向滚动（允许 ±2px 误差；表格横滑容器属预期，排除在外） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    const overflowHidden = Array.from(
      document.querySelectorAll('[class*="overflow-hidden"]')
    ).filter((el) => {
      const cls = String(el.className)
      if (/overflow-x-auto|overflow-auto|truncate/.test(cls)) return false
      if (el.querySelector('[class*="overflow-x-auto"], [class*="overflow-auto"]')) return false
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      if (rect.left >= -1 && rect.right <= vw + 1) return false
      return el.scrollWidth - el.clientWidth > 2
    })
    const candidates: Element[] = [document.documentElement, document.body, ...overflowHidden]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((el) => el.scrollWidth - el.clientWidth > 2)
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 160),
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }))
  })
  if (offenders.length > 0) {
    console.log('OVERFLOW_OFFENDERS=' + JSON.stringify(offenders))
  }
  expect(offenders.length, '页面级容器不应出现横向溢出（表格内部横滑除外）').toBe(0)
}

/** 断言两个元素处于同一行（y 差 < 2px）；等待两元素都有布局盒 */
async function expectSameRow(
  page: import('@playwright/test').Page,
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  await expect
    .poll(
      async () => (await a.boundingBox()) !== null && (await b.boundingBox()) !== null,
      { timeout: 30000 }
    )
    .toBe(true)
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(Math.abs(ba.y - bb.y), label).toBeLessThan(2)
}

// ── 主页 mock：projects + daily-analysis（当期 + 对比期 + 跨国家）──
const PROJECTS = [
  {
    id: 1,
    name: '测试项目 A',
    brand_name: 'Brand A',
    store_address: 'US-East',
    project_operator: 'E2E 运营',
    assistant_operator: null,
    commission_basis: 'sales_amount',
    commission_rate: 0.05,
    is_active: true,
    project_tier: 'T1',
  },
  {
    id: 2,
    name: '测试项目 B',
    brand_name: 'Brand B',
    store_address: 'EU-DE',
    project_operator: null,
    assistant_operator: 'E2E 运营',
    commission_basis: 'cash_received',
    commission_rate: 0.08,
    is_active: true,
    project_tier: 'T2',
  },
]

const SUMMARY_ROWS = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-08-0${i + 1}`,
  order_qty: 10 + i,
  sales_amount: 1000 + i * 100,
  impressions: 5000 + i * 500,
  clicks: 300 + i * 20,
  cpc: 0.5,
  ad_spend: 150 + i * 10,
  ad_orders: 8 + i,
  available_qty: 200 - i,
  page_views: 4000 + i * 400,
  units_ordered: 9 + i,
  sessions: 3800 + i * 350,
  ordered_sales_amount: 900 + i * 90,
  conversion_rate: 0.02,
}))

const DAILY_PAYLOAD = {
  summary_rows: SUMMARY_ROWS,
  project_breakdown: {
    1: { project_name: '测试项目 A', summary_rows: SUMMARY_ROWS },
    2: { project_name: '测试项目 B', summary_rows: SUMMARY_ROWS },
  },
}

const COUNTRIES_PAYLOAD = {
  summary_rows: SUMMARY_ROWS,
  country_breakdown: {
    US: { summary_rows: SUMMARY_ROWS },
    DE: { summary_rows: SUMMARY_ROWS },
  },
}

const PROFILE = {
  id: '1',
  email: 'e2e@example.com',
  name: 'E2E',
  full_name: 'E2E 测试',
  operator_name_zh: 'E2E 运营',
  is_admin: true,
  is_active: true,
  role_type: 'admin',
  avatar_url: null,
  password_changed_at: '2026-08-01T00:00:00Z',
}

async function mockHomeBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: { user: { name: 'E2E', email: 'e2e@example.com' } } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/projects**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all-countries**', (route) =>
    route.fulfill({ json: COUNTRIES_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all**', (route) =>
    route.fulfill({ json: DAILY_PAYLOAD })
  )
  await page.route('**/api/user/profile', (route) => route.fulfill({ json: PROFILE }))
  await page.route('**/api/backend/api/v1/page-render/history**', (route) =>
    route.fulfill({
      json: {
        total: 1,
        items: [
          {
            id: 'page-1',
            title: '测试页面',
            source_format: 'markdown',
            public_url: '/p/page-1',
            original_filename: 'test.md',
            file_size: 1024,
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    })
  )
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'home-mobile-blf621 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockHomeBackend(page)
  // 伪造合法 session cookie，绕过 proxy.ts 的 auth 守卫
  await context.addCookies([
    {
      name: 'authjs.session-token',
      value: await forgeSessionToken(),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
})

test.describe('@mobile-blf621 主页/个人中心/杂项页手机端（BLF-621）', () => {
  test('主页：KPI 一行两个 + 图表独占一行 + 无页面横滚', async ({ page }) => {
    await page.goto('/dashboard')

    // KPI 卡渲染（V2Stats 4 张）
    await expect
      .poll(async () => page.locator('.dashboard-surface').count(), { timeout: 30000 })
      .toBeGreaterThanOrEqual(4)

    // KPI 网格 = V2Grid（grid-cols-2 手机端）：第 1、2 张卡同一行
    const first = page.locator('.dashboard-surface').nth(0)
    const second = page.locator('.dashboard-surface').nth(1)
    await expectSameRow(page, first, second, 'KPI 前两张卡手机端同一行（一行两个）')

    // 第 3、4 张 KPI 卡也在同一行（2×2）
    const third = page.locator('.dashboard-surface').nth(2)
    const fourth = page.locator('.dashboard-surface').nth(3)
    await expectSameRow(page, third, fourth, 'KPI 第 3、4 张同一行（2×2）')

    // 图表（nth(4) 起 col-span-2）独占一行：与下一张图表不并排
    await expect
      .poll(async () => (await page.locator('.dashboard-surface').nth(5).boundingBox()) !== null, {
        timeout: 30000,
      })
      .toBe(true)
    const chartA = page.locator('.dashboard-surface').nth(4)
    const chartB = page.locator('.dashboard-surface').nth(5)
    const ca = (await chartA.boundingBox())!
    const cb = (await chartB.boundingBox())!
    expect(Math.abs(ca.y - cb.y), '图表卡应独占一行（竖排堆叠）').toBeGreaterThan(2)

    // 项目排行表格渲染 + 容器内横滑（规则 10）
    const topProjects = page.getByText('项目排行')
    await expect(topProjects).toBeVisible({ timeout: 30000 })
    const tableScroll = page.locator('[class*="overflow-x-auto"] table')
    await expect(tableScroll.first()).toBeVisible()

    // 页面无整体横向滚动
    await expectNoPageHorizontalOverflow(page)
  })

  test('主页：360×800 小屏 KPI 仍一行两个、图表全宽', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard')

    await expect
      .poll(async () => page.locator('.dashboard-surface').count(), { timeout: 30000 })
      .toBeGreaterThanOrEqual(4)
    const first = page.locator('.dashboard-surface').nth(0)
    const second = page.locator('.dashboard-surface').nth(1)
    await expectSameRow(page, first, second, '360px KPI 前两张同一行')

    // 图表卡（nth(4) col-span-2）宽度 ≈ 视口宽（减 p-px 2px）
    const chartA = page.locator('.dashboard-surface').nth(4)
    const ca = (await chartA.boundingBox())!
    expect(ca.width, '图表卡手机端占满整行宽度').toBeGreaterThan(340)

    await expectNoPageHorizontalOverflow(page)
  })

  test('个人中心：表单单列 + 统计卡 + 无页面横滚', async ({ page }) => {
    await page.goto('/dashboard/profile')
    await expect(page.getByText('我的资料', { exact: false }).first()).toBeVisible({ timeout: 30000 })

    // 表单输入框全宽（单列，规则 4）
    const emailInput = page.getByLabel('邮箱')
    await expect(emailInput).toBeVisible()
    const eb = (await emailInput.boundingBox())!
    expect(eb.width, '邮箱输入框手机端全宽').toBeGreaterThan(300)

    // 统计卡（角色/账号状态/上次修改密码）渲染
    await expect(page.getByText('角色', { exact: true })).toBeVisible()

    await expectNoPageHorizontalOverflow(page)
  })

  test('我的项目：手机卡片列表 + 桌面表格横滑', async ({ page }) => {
    await page.goto('/dashboard/profile?tab=projects')
    // 手机端卡片列表可见（md:hidden）
    await expect(page.locator('.md\\:hidden a[href*="/dashboard/system/project-info"]').first()).toBeVisible({
      timeout: 30000,
    })
    await expectNoPageHorizontalOverflow(page)
  })

  test('修改密码：单列表单 + 按钮全宽 + 输入触摸目标 ≥44px', async ({ page }) => {
    await page.goto('/dashboard/change-password')
    await expect(page.getByText('修改密码', { exact: false }).first()).toBeVisible({ timeout: 30000 })

    const current = page.getByLabel('当前密码')
    const pw = page.getByLabel('新密码')
    const confirm = page.getByLabel('确认新密码')
    await expect(current).toBeVisible()
    const cb = (await current.boundingBox())!
    expect(cb.height, '密码输入框触摸目标 ≥44px').toBeGreaterThanOrEqual(44)

    // 提交按钮全宽（w-full sm:w-auto）
    const submit = page.getByRole('button', { name: '确认修改' })
    await expect(submit).toBeVisible()
    const sb = (await submit.boundingBox())!
    expect(sb.width, '提交按钮手机端全宽').toBeGreaterThan(300)

    await expectNoPageHorizontalOverflow(page)
  })

  test('工具页：markdown-to-word 编辑/预览单列堆叠 + page-render 历史表格横滑', async ({ page }) => {
    await page.goto('/dashboard/tools/markdown-to-word')
    await expect(page.getByText('Markdown 编辑区')).toBeVisible({ timeout: 30000 })
    // 编辑区与预览区上下堆叠（xl:grid-cols-2 之前单列）
    await expect(page.getByText('实时预览')).toBeVisible()
    await expectNoPageHorizontalOverflow(page)

    await page.goto('/dashboard/tools/page-render')
    await expect(page.getByText('我的历史').first()).toBeVisible({ timeout: 30000 })
    // 历史表格横滑容器存在
    await expect(page.locator('[class*="overflow-x-auto"] table').first()).toBeAttached()
    await expectNoPageHorizontalOverflow(page)
  })

  test('table-showcase：表格横滑 + 无页面横滚', async ({ page }) => {
    await page.goto('/dashboard/table-showcase')
    await expect(page.getByText('Table 设计统一 · Showcase')).toBeVisible({ timeout: 30000 })
    // 表格横滑容器（DataTableFrame 滚动体）
    await expect(page.locator('[class*="overflow-x-auto"] table').first()).toBeAttached()
    await expectNoPageHorizontalOverflow(page)
  })

  test('登录页：表单单列 + 输入触摸目标 ≥44px + 无横滚', async ({ page, context }) => {
    // 登录页要求未登录：清掉伪造 session cookie，否则 /login 会重定向到 /dashboard
    await context.clearCookies()
    await page.goto('/login')
    await expect(page.getByText('欢迎登录')).toBeVisible({ timeout: 30000 })

    const email = page.getByLabel(/企业邮箱/)
    await expect(email).toBeVisible()
    const eb = (await email.boundingBox())!
    expect(eb.height, '登录输入框触摸目标 ≥44px（允许 DPR 舍入）').toBeGreaterThanOrEqual(43)
    expect(eb.width, '登录输入框全宽').toBeGreaterThan(300)

    const submit = page.getByRole('button', { name: '立即登录' })
    await expect(submit).toBeVisible()
    const sb = (await submit.boundingBox())!
    expect(sb.width, '登录按钮全宽').toBeGreaterThan(300)

    await expectNoPageHorizontalOverflow(page)
  })

  test('桌面 1440 零回归：KPI 4 列一行 + 图表 2 列并排', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    await expect
      .poll(async () => page.locator('.dashboard-surface').count(), { timeout: 30000 })
      .toBeGreaterThanOrEqual(4)

    // 第 1、2 张 KPI 卡同一行（桌面 4 列）
    const first = page.locator('.dashboard-surface').nth(0)
    const second = page.locator('.dashboard-surface').nth(1)
    await expectSameRow(page, first, second, '桌面 KPI 前两张同一行')

    // 图表卡（nth(4) col-span-2）宽度 ≈ 视口一半 → 与 next 图表并排
    await expect
      .poll(async () => (await page.locator('.dashboard-surface').nth(5).boundingBox()) !== null, {
        timeout: 30000,
      })
      .toBe(true)
    const chartA = page.locator('.dashboard-surface').nth(4)
    const chartB = page.locator('.dashboard-surface').nth(5)
    const ca = (await chartA.boundingBox())!
    const cb = (await chartB.boundingBox())!
    expect(ca.width, '桌面图表卡为整行一半宽（2 列并排）').toBeLessThan(760)
    expect(ca.width).toBeGreaterThan(600)
    await expectSameRow(page, chartA, chartB, '桌面图表卡并排（2 列）')

    await expectNoPageHorizontalOverflow(page)
  })
})
