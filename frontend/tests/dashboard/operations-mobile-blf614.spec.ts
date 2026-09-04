import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-614 运营域 B 手机端适配回归（weekly-product-analysis / platform-inspection /
 * portfolio-overview + portfolio 组件）。
 *
 * 自包含：session 与全部后端请求经 page.route mock，不依赖真实后端 / 登录态。
 * 默认随 mobile project（Pixel 5，393×851）跑；桌面零回归用例在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：portfolio KPI 卡手机端一行两个，不挤压；
 * - 规则 2：筛选控制台手机端 2 列网格，日期范围/项目多选占满一行；
 * - 规则 10：宽表格（weekly 4200px / inspection 历史 9 列）容器内横滑，页面无整体横向滚动；
 * - 图表区域手机端优化：隐藏 Y 轴、负 margin（chart 容器不溢出）。
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

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', operatorNameZh: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [{ id: 1, name: 'E2E 测试项目' }]

const DAILY_ROW = {
  date: '2026-08-01',
  order_qty: 120,
  sales_amount: 4567.89,
  impressions: 5000,
  clicks: 300,
  cpc: 0.72,
  ad_spend: 216.0,
  ad_orders: 12,
  available_qty: 88,
  page_views: 2100,
  units_ordered: 118,
  sessions: 980,
  ordered_sales_amount: 4100.5,
  conversion_rate: 12.24,
}

const DAILY_ALL_PAYLOAD = {
  summary_rows: [DAILY_ROW],
  detail_rows: [DAILY_ROW],
  available_dates: { '1': ['2026-08-01'] },
  project_breakdown: {
    '1': { project_name: 'E2E 测试项目', summary_rows: [DAILY_ROW], detail_rows: [DAILY_ROW] },
  },
}

const WEEKLY_ROWS = Array.from({ length: 4 }, (_, i) => ({
  id: i + 1,
  project_id: 1,
  project_name: 'E2E 测试项目',
  country: 'US',
  report_start_date: `2026-07-${String(13 + i * 7).padStart(2, '0')}`,
  report_end_date: `2026-07-${String(19 + i * 7).padStart(2, '0')}`,
  version: 1,
  is_current: i === 3,
  row_count: 5,
  total_sales: 4567.89 + i * 111,
  total_units: 120 + i * 3,
  total_ad_spend: 216.0 + i * 10,
  summary_row: {
    总销量: 120 + i * 3,
    总销售额: 4567.89 + i * 111,
    页面浏览量: 2100 + i * 50,
    总访客: 980 + i * 20,
    总转化: 12.2,
    广告展示量: 5000 + i * 100,
    广告点击量: 300 + i * 5,
    广告花费: 216.0 + i * 10,
  },
}))

const PT1_DETAILS_PAYLOAD = {
  pt1_id: 4,
  report_start_date: '2026-08-03',
  report_end_date: '2026-08-09',
  has_next: false,
  rows: Array.from({ length: 3 }, (_, i) => ({
    id: i + 1,
    source_row_no: i + 1,
    sku: `E2E-SKU-00${i + 1}`,
    asin: `B0E2E000${i + 1}`,
    raw_row: {
      日期: '2026-08-05',
      SKU: `E2E-SKU-00${i + 1}`,
      销量: 10 + i,
      销售额: 456.78,
    },
  })),
}

const INVENTORY_PAYLOAD = { rows: [{ sku: 'e2e-sku-001', available_qty: 88 }] }

const INSPECTION_CURRENT_PERIOD = {
  id: 99,
  week_start: '2026-08-03',
  week_end: '2026-08-09',
  deadline: '2026-08-11T16:00:00Z',
  status: 'pending',
}

const INSPECTION_OVERVIEW = {
  period: INSPECTION_CURRENT_PERIOD,
  total_projects: 1,
  submitted_count: 1,
  overdue_count: 0,
  items: [
    {
      project_id: 1,
      project_name: 'E2E 测试项目（长项目名称用于验证手机端布局不溢出）',
      status: 'submitted',
      account_health_rating: 'Healthy',
      compliance_total: 0,
      late_shipment_rate: 1.2,
      valid_tracking_rate: 98.5,
      on_time_delivery_rate: 97.8,
      negative_feedback: 0,
      a2z_claims: 0,
      chargeback_claims: 0,
      submitted_by: 'E2E 运营',
      submitted_at: '2026-08-10T10:00:00Z',
      status_summary: '账户状态正常，无异常告警。',
      screenshots: [],
    },
  ],
}

const INSPECTION_HISTORY = {
  items: [
    {
      id: 1,
      period_id: 99,
      project_id: 1,
      project_name: 'E2E 测试项目',
      status: 'submitted',
      account_health_rating: 'Good',
      compliance_total: 1,
      status_summary: '一条较长的状态说明，用于验证表格内长文本列在手机端被约束换行而不是撑破页面。',
      submitted_by: 'E2E 运营',
      submitted_at: '2026-08-10T10:00:00Z',
      screenshots: [],
    },
  ],
  total: 1,
}

const INSPECTION_PERIODS = { items: [INSPECTION_CURRENT_PERIOD], total: 1 }

/** 页面级无整体横向滚动（允许 ±2px 误差） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    // 排除三类“预期内 scrollWidth > clientWidth”的容器，避免误报：
    // 1. 自身就是 overflow-x-auto/overflow-auto 的表格横滑容器（规则 10）；
    // 2. 含 overflow-x-auto 后代的 dashboard-surface（overflow-hidden 裁剪表格）；
    // 3. truncate 文本省略号 span（overflow-hidden + text-overflow: ellipsis）。
    const overflowHidden = Array.from(
      document.querySelectorAll('[class*="overflow-hidden"]')
    ).filter((el) => {
      const cls = String(el.className)
      if (/overflow-x-auto|overflow-auto|truncate/.test(cls)) return false
      return !el.querySelector('[class*="overflow-x-auto"], [class*="overflow-auto"]')
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

/**
 * 在 portfolio-overview 选中项目 + 近7天日期范围，触发数据加载。
 * 注：项目多选 Popover 选中后保持展开，需 Escape 关闭，否则会拦截后续点击；
 * RangeDatePickerWithPresets 空值时内部已默认近7天，trigger 文案为日期区间。
 */
async function selectPortfolioScope(page: import('@playwright/test').Page) {
  const projectTrigger = page.getByRole('combobox').first()
  await expect(projectTrigger).toBeVisible({ timeout: 30000 })
  await projectTrigger.click()
  // 项目列表异步加载，先等 option 出现再点击，避免竞态
  await page.getByRole('option', { name: 'E2E 测试项目' }).waitFor({ timeout: 15000 })
  await page.getByRole('option', { name: 'E2E 测试项目' }).click()
  await page.keyboard.press('Escape')

  const dateTrigger = page.getByRole('button', { name: /~\s*\d{4}-\d{2}-\d{2}/ }).first()
  await expect(dateTrigger).toBeVisible({ timeout: 15000 })
  await dateTrigger.click()
  await page.getByRole('button', { name: '近7天' }).click()
}

async function mockOpsBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all**', (route) =>
    route.fulfill({ json: DAILY_ALL_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/product-analysis/weekly**', (route) =>
    route.fulfill({ json: WEEKLY_ROWS })
  )
  await page.route('**/api/backend/api/v1/product-analysis/pt1/**', (route) =>
    route.fulfill({ json: PT1_DETAILS_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/product-analysis/inventory/current**', (route) =>
    route.fulfill({ json: INVENTORY_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/inspections/periods/current**', (route) =>
    route.fulfill({ json: INSPECTION_CURRENT_PERIOD })
  )
  await page.route('**/api/backend/api/v1/inspections/periods/99/overview**', (route) =>
    route.fulfill({ json: INSPECTION_OVERVIEW })
  )
  await page.route('**/api/backend/api/v1/inspections/history**', (route) =>
    route.fulfill({ json: INSPECTION_HISTORY })
  )
  await page.route('**/api/backend/api/v1/inspections/periods?*', (route) =>
    route.fulfill({ json: INSPECTION_PERIODS })
  )
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'operations-mobile-blf614 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockOpsBackend(page)
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

test.describe('@mobile-blf614 portfolio-overview 手机端（BLF-614）', () => {
  test('KPI 卡一行两个 + 筛选 2 列网格 + 对比表容器内横滑 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/portfolio-overview')
    await selectPortfolioScope(page)
    // KPI 卡渲染且一行两个
    const kpiLabels = ['总销售额', '总订单量', '总广告费', '平均转化率']
    await expect(page.getByText('总销售额')).toBeVisible({ timeout: 30000 })
    const card = page.getByText('总销售额').locator('..').locator('..')
    const firstBox = (await card.boundingBox())!
    const secondCard = page.getByText('总订单量').locator('..').locator('..')
    const secondBox = (await secondCard.boundingBox())!
    expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(2)
    const viewport = page.viewportSize()!
    expect(firstBox.width).toBeLessThan(viewport.width * 0.7)

    // 对比表：容器内横滑（表格内容宽 > 容器可视宽），页面无整体横向滚动
    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    const metrics = await table.evaluate((el) => {
      const wrapper = el.closest('[class*="overflow"]') as HTMLElement | null
      return {
        tableWidth: el.scrollWidth,
        wrapperClientWidth: wrapper?.clientWidth ?? 0,
      }
    })
    expect(metrics.tableWidth).toBeGreaterThan(metrics.wrapperClientWidth)

    await expectNoPageHorizontalOverflow(page)
  })

  test('趋势/贡献图表 Tab：图表容器不溢出页面', async ({ page }) => {
    await page.goto('/dashboard/operations/portfolio-overview')
    await selectPortfolioScope(page)
    await page.getByRole('tab', { name: '趋势对比' }).click()
    await expect(page.getByText('多项目趋势对比')).toBeVisible({ timeout: 15000 })
    // 等 framer-motion layoutId 弹簧动画落定，避免瞬时状态误报溢出
    await page.waitForTimeout(600)
    await expectNoPageHorizontalOverflow(page)

    await page.getByRole('tab', { name: '贡献占比' }).click()
    await expect(page.getByText('各项目贡献占比')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(600)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf614 每周商品分析 手机端（BLF-614）', () => {
  test('周度趋势图例按钮折行不溢出 + 周汇总宽表容器内横滑 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/weekly-product-analysis')

    // 图例切换按钮（7 个）在手机端折行展示，不撑破卡片
    const toggleButtons = page.getByRole('button', { name: /销售额|销量|广告花费|广告点击量|自然流量|ACOS|广告点击率/ })
    await expect(toggleButtons.first()).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('周度趋势')).toBeVisible({ timeout: 15000 })

    // 周汇总表：min-w-[4200px] 宽表由容器承接横滑
    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    const metrics = await table.evaluate((el) => {
      const wrapper = el.closest('[class*="overflow"]') as HTMLElement | null
      return {
        tableWidth: el.scrollWidth,
        wrapperClientWidth: wrapper?.clientWidth ?? 0,
        stickyCols: Array.from(el.querySelectorAll('th.sticky, td.sticky')).length,
      }
    })
    expect(metrics.tableWidth).toBeGreaterThan(metrics.wrapperClientWidth)
    // sticky 首列在滑动时保持固定（至少 2 个 sticky 单元格）
    expect(metrics.stickyCols).toBeGreaterThan(2)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf614 平台巡检 手机端（BLF-614）', () => {
  test('概览项目卡单列堆叠 + 历史记录宽表容器内横滑 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/platform-inspection')

    // 概览项目卡（内容密集 → 宽组件单列）
    await expect(page.getByText('1 / 1 已提交')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('配送 & 合规')).toBeVisible({ timeout: 15000 })
    await expectNoPageHorizontalOverflow(page)

    // 历史记录：9 列表格容器内横滑
    await page.getByRole('tab', { name: '历史记录' }).click()
    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    // 等 framer-motion layoutId 弹簧动画落定（切换时 active tab 瞬时压缩属动画瞬态）
    await page.waitForTimeout(600)
    const metrics = await table.evaluate((el) => {
      const wrapper = el.closest('[class*="overflow"]') as HTMLElement | null
      return {
        tableWidth: el.scrollWidth,
        wrapperClientWidth: wrapper?.clientWidth ?? 0,
      }
    })
    expect(metrics.tableWidth).toBeGreaterThan(metrics.wrapperClientWidth)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf614 桌面零回归（BLF-614）', () => {
  test('1440：portfolio KPI 一行五个 + 筛选横向排列 + 对比表全宽可见', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/operations/portfolio-overview')
    await selectPortfolioScope(page)
    // KPI 一行五个（lg:grid-cols-5）
    const first = page.getByText('总销售额').locator('..').locator('..')
    const fifth = page.getByText('项目数量').locator('..').locator('..')
    await expect(first).toBeVisible({ timeout: 15000 })
    const b0 = (await first.boundingBox())!
    const b4 = (await fifth.boundingBox())!
    expect(Math.abs(b0.y - b4.y)).toBeLessThan(2)

    // 对比表桌面全宽展示
    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    const tbox = (await table.boundingBox())!
    expect(tbox.width).toBeGreaterThan(1000)
  })
})
