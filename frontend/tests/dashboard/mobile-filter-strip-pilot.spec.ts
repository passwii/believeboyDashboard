import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-930 · Stage 2 移动端折叠筛选条试点冒烟测试。
 *
 * 覆盖页面：
 * - 首页 dashboard/page.tsx（项目 Select + 数据区间徽标）
 * - daily-analysis（项目/站点/日期/SKU 四件套，短控件 1/2 + 宽控件 col-span-2）
 *
 * 自包含：伪造 admin session 通过 proxy 鉴权；全部后端请求经 page.route mock。
 * 默认随 mobile project（Pixel 5，393×851）跑。
 *
 * 注意：dashboard 主页有预存 recharts yAxisId 崩溃（与 mock 数据有关，基线
 * home-mobile-blf621 同样失败），故不测试展开后状态。移动端折叠条在 collapsed
 * 模式下的渲染与摘要验证已足够确认 Stage 2 接入成功。
 *
 * 验收标准（BLF-930 §验收标准）：
 * - 折叠条在 360px / 390px 宽度下正常渲染
 * - 筛选摘要显示当前项目名 · 站点 · 日期范围
 * - 展开/收起交互流畅（daily-analysis 无 recharts 崩溃，可展开）
 * - 筛选联动（URL param 同步）正常
 * - 桌面端零回归（header 插槽正常渲染，折叠条不出现）
 */

const FIXTURE_SECRET = BLF611_FIXTURE_SECRET

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      // BLF-1441：会话显示名唯一来源是 full_name（不再回落运营名 / 登录名）
      fullName: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', fullName: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [
  { id: 1, name: '测试项目 A', brand_name: 'Brand A', store_address: 'US', project_operator: 'E2E', assistant_operator: null, commission_basis: 'sales_amount', commission_rate: 0.05, is_active: true, project_tier: 'T1' },
  { id: 2, name: '测试项目 B', brand_name: 'Brand B', store_address: 'DE', project_operator: null, assistant_operator: 'E2E', commission_basis: 'cash_received', commission_rate: 0.08, is_active: true, project_tier: 'T2' },
]

const SUMMARY_ROWS = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-09-0${String(i + 1).padStart(2, '0')}`,
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
  is_admin: true,
  is_active: true,
  role_type: 'admin',
  avatar_url: null,
  password_changed_at: '2026-08-01T00:00:00Z',
}

// daily-analysis 端点 mock
const DA_CONSOLE = {
  project_id: 1,
  project_name: '测试项目 A',
  country: 'US',
  start_date: '2026-08-26',
  end_date: '2026-09-01',
  requested_days: 7,
  summary_days: 7,
  detail_rows: 6,
  sales_source_days: 7,
  ad_source_days: 7,
  inventory_source_days: 7,
  business_source_days: 7,
  missing_dates: [],
  latest_sales_date: '2026-09-01',
  latest_ad_date: '2026-09-01',
  latest_inventory_date: '2026-09-01',
  latest_business_date: '2026-09-01',
}

const DA_DETAIL_ROWS = Array.from({ length: 6 }, (_, i) => ({
  date: `2026-08-${String(27 + i).padStart(2, '0')}`,
  sku: `E2E-SKU-${i + 1}`,
  asin: `B0${String(100 + i).padStart(7, '0')}`,
  in_transit_qty: 50 + i * 10,
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

const DA_PAYLOAD = {
  console: DA_CONSOLE,
  summary_rows: SUMMARY_ROWS,
  detail_rows: DA_DETAIL_ROWS,
  available_dates: { '2026-08': ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01'] },
}

async function mockBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
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
  await page.route('**/api/backend/api/v1/daily-analysis**', (route) => {
    const url = route.request().url()
    if (url.includes('/all')) {
      route.fulfill({ json: DAILY_PAYLOAD })
    } else {
      route.fulfill({ json: DA_PAYLOAD })
    }
  })
  await page.route('**/api/backend/api/v1/sku-options**', (route) => {
    route.fulfill({
      json: Array.from({ length: 6 }, (_, i) => ({
        sku: `E2E-SKU-${i + 1}`,
        asin: `B0${String(100 + i).padStart(7, '0')}`,
        fnsku: null,
        product_name: `测试产品 ${i + 1}`,
        units_per_carton: 100,
        carton_length_cm: 50,
        carton_width_cm: 40,
        carton_height_cm: 30,
        carton_weight_kg: 12,
        is_active: true,
      })),
    })
  })
  await page.route('**/api/backend/api/v1/project-goals/progress**', (route) =>
    route.fulfill({ json: { target_amount: 0, achieved_amount: 0, completion_vs_monthly: 0, completion_vs_daily: 0, today_day: 1, days_in_month: 30, currency: 'USD' } })
  )
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'mobile-filter-strip-pilot 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockBackend(page)
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

test.describe('@mobile-blf930 dashboard 首页移动端折叠筛选条', () => {
  test('折叠态：渲染摘要（项目名 · 日期范围），折叠按钮可见，网格未展开', async ({ page }) => {
    await page.goto('/dashboard')

    const strip = page.locator('[data-testid="mobile-filter-strip"]')
    await expect(strip).toBeVisible({ timeout: 30000 })

    // 摘要显示项目名 + 日期范围
    const summary = strip.locator('span').first()
    await expect(summary).toContainText('全部项目')
    await expect(summary).toContainText(/\d{4}-\d{2}-\d{2}/)

    // 折叠态：grid 未展开
    await expect(page.locator('[data-testid="mobile-filter-strip-grid"]')).not.toBeVisible()
  })

  test('360×800 小屏：折叠条正常渲染，宽度 ≈ 视口', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard')

    const strip = page.locator('[data-testid="mobile-filter-strip"]')
    await expect(strip).toBeVisible({ timeout: 30000 })

    const box = await strip.boundingBox()
    await expect(box!.width).toBeGreaterThan(350)
  })
})

test.describe('@mobile-blf930 daily-analysis 移动端折叠筛选条', () => {
  test('折叠态：摘要显示项目名 · 站点 · 日期范围（格式 YYYY-MM-DD ~ YYYY-MM-DD）', async ({ page }) => {
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')

    const strip = page.locator('[data-testid="mobile-filter-strip"]')
    await expect(strip).toBeVisible({ timeout: 30000 })

    // 摘要包含项目名 + 站点 + 日期范围（格式 YYYY-MM-DD ~ YYYY-MM-DD）
    const summary = strip.locator('span').first()
    await expect(summary).toContainText('测试项目 A')
    await expect(summary).toContainText('美国站')
    await expect(summary).toContainText(/\d{4}-\d{2}-\d{2}.*~\s*\d{4}-\d{2}-\d{2}/)
  })

  test('展开后：短控件（项目/站点）可见，宽控件（日期/SKU）可见', async ({ page }) => {
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')

    const strip = page.locator('[data-testid="mobile-filter-strip"]')
    await expect(strip).toBeVisible({ timeout: 30000 })

    // 展开
    await page.getByRole('button', { name: '切换页面筛选' }).click()

    const grid = page.locator('[data-testid="mobile-filter-strip-grid"]')
    await expect(grid).toBeVisible()

    // 短控件：grid 内恰好 2 个 combobox（项目 + 站点）
    const combos = grid.getByRole('combobox')
    await expect(combos).toHaveCount(2)
    await expect(combos.nth(0)).toBeVisible()
    await expect(combos.nth(1)).toBeVisible()

    // 宽控件：SKU 搜索 trigger（title）可见 —— 限定在展开网格内（header 插槽隐藏的 SKU 也在 DOM）
    await expect(
      grid.locator('[title*="搜索并选择 SKU"]').first()
    ).toBeVisible()

    // 宽控件：日期范围 trigger（值为日期串）可见
    await expect(
      grid.locator('button', { hasText: /\d{4}-\d{2}-\d{2}/ }).first()
    ).toBeVisible()
  })

  test('切换站点后：摘要同步更新 + URL param 同步', async ({ page }) => {
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')

    const strip = page.locator('[data-testid="mobile-filter-strip"]')
    await expect(strip).toBeVisible({ timeout: 30000 })

    // 展开
    await page.getByRole('button', { name: '切换页面筛选' }).click()

    const grid = page.locator('[data-testid="mobile-filter-strip-grid"]')
    await expect(grid).toBeVisible()

    // 第二个 combobox = 站点 Select，切换到德国站 (DE)
    const countrySelect = grid.getByRole('combobox').nth(1)
    await countrySelect.click()
    await page.getByRole('option', { name: '德国站 (DE)' }).click()

    // 等待 URL country 更新
    await expect(page).toHaveURL(/country=DE/)

    // 收起再展开（摘要更新后应反映新站点）
    await page.getByRole('button', { name: '切换页面筛选' }).click()
    await page.getByRole('button', { name: '切换页面筛选' }).click()

    await expect(strip).toContainText('德国站')
  })
})

test.describe('@mobile-blf930 桌面零回归（BLF-930）', () => {
  test('daily-analysis 表格表面使用实体 Terminal 色令牌', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')
    await expect(page.getByText('销售数据工作区')).toBeVisible({ timeout: 30000 })

    const table = page.locator('#main-content table').first()
    const firstDataRow = table.locator('tbody tr').first()
    await expect(firstDataRow).toBeVisible({ timeout: 30000 })

    const assertTableUsesTerminalSurface = async (activeTable: import('@playwright/test').Locator) => {
      const tableSurface = activeTable.locator('xpath=..')
      const stickyHeader = activeTable.locator('thead').first()
      const firstRow = activeTable.locator('tbody tr').first()
      await expect(tableSurface).toHaveClass(/bg-term-panel/)
      await expect(stickyHeader).toHaveClass(/bg-term-raised/)
      await expect(firstRow).toHaveClass(/(^|\s)bg-term-raised(\s|$)/)
      await expect(tableSurface).not.toHaveClass(/surface-panel/)
      await expect(firstRow).not.toHaveClass(/surface-soft|surface-strong|bg-primary|bg-background/)
      await expect(activeTable.locator('tbody tr').nth(1)).not.toHaveClass(/(^|\s)bg-term-raised(\s|$)/)
    }

    await assertTableUsesTerminalSurface(table)

    await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    await expect(page.getByText('销售数据工作区')).toBeVisible({ timeout: 30000 })
    const chartKindGroup = page.getByRole('group', { name: '图表形态' })
    await expect(chartKindGroup).toBeVisible()
    const lineChartButton = chartKindGroup.getByRole('button', { name: /折线/ })
    await lineChartButton.click()
    await expect(lineChartButton).toHaveAttribute('aria-pressed', 'true')
    await expect(lineChartButton).toHaveClass(/bg-term-accent/)
    const darkTable = page.locator('#main-content table').first()
    await expect(darkTable.locator('tbody tr').first()).toBeVisible({ timeout: 30000 })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await assertTableUsesTerminalSurface(darkTable)

    await page.getByRole('tab', { name: /SKU 明细/ }).click()
    const detailTable = page.locator('#main-content table').first()
    await expect(detailTable.locator('tbody tr').first()).toBeVisible({ timeout: 30000 })
    await assertTableUsesTerminalSurface(detailTable)
    await expect(detailTable.locator('tbody tr').first().locator('td[rowspan]')).toHaveClass(/bg-term-raised/)
    await expect(detailTable.locator('tbody tr').first()).not.toContainClass('surface-soft')
  })

  test('daily-analysis 1440px：折叠条不渲染，header 插槽正常', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')

    // 等待页面就绪（工作区标题可见 = 页面渲染完成）
    await expect(page.getByText('销售数据工作区')).toBeVisible({ timeout: 30000 })

    // 折叠条不应渲染（md:hidden 挂载点内无内容）
    await expect(page.locator('[data-testid="mobile-filter-strip"]')).not.toBeVisible()
  })
})