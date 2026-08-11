import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-611 广告域手机端适配回归（ad-analysis + ad-data）。
 *
 * 自包含：session 与全部后端请求经 page.route mock，不依赖真实后端 / 登录态，
 * 可在无 .env.local 的环境直接跑。默认随 mobile project（Pixel 5，393×851）跑；
 * 桌面零回归用例在测试内切 1440×900 视口。
 *
 * 认证：/dashboard 由 proxy.ts（next-auth v5 auth 中间件）守卫，需要合法 JWE
 * session cookie；这里用 next-auth/jwt 的 encode 以 BLF611_FIXTURE_SECRET 伪造一枚
 *（secret 与 playwright.config webServer.env / 运行时 .env.local 替换值一致）。
 *
 * 本地运行注意：若本机 :3200 已有 dev server 在跑（env 可能与 fixture 不一致），
 * 先停掉再跑；playwright.config.ts 会在 webServer 启动前把 .env.local 临时替换为
 * fixture-only 内容并在退出时还原。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：KPI/汇总卡手机端一行两个，不挤压；
 * - 总则 2：宽组件（表格/卡片列表容器）独占一行；
 * - 规则 2：筛选控制台手机端 2 列网格，日期范围独占一行；
 * - 规则 10：ad-data 原始表保持列宽（min-width: max-content 兜底），容器内横滑，页面无整体横向滚动。
 */

// 与 playwright.config.ts 保持一致（来自共享 fixture 模块）
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

const LONG_CAMPAIGN =
  'SP - Auto - US - 超长活动名称用来验证手机端布局不会被长文本撑破视口造成页面整体横向滚动 - 2026 - 001'

function makeSummaryCards(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    label: `汇总指标 ${i + 1}`,
    value: `$${(12345.67 + i * 111).toFixed(2)}`,
    helper: '较上周期 +1.23%',
  }))
}

function makeCampaignItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    campaign_name: `${LONG_CAMPAIGN} #${i + 1}`,
    status: '投放中',
    targeting_type: 'auto',
    bidding_strategy: 'dynamic bids - down only',
    budget: 50,
    impressions: 12345,
    clicks: 234,
    ctr: 0.019,
    cpc: 0.72,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    acos: 0.3288,
    roas: 3.04,
    grade: 'B',
    budget_gap: 12.5,
    budget_utilization_rate: 0.91,
    missed_sales_max: 88.8,
    cross_sell_orders_7d: 3,
    cross_sell_sales_7d: 96.2,
    cross_sell_action: '观察',
    next_action: '保持投放',
  }))
}

const CAMPAIGNS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  summary_cards: makeSummaryCards(6),
  narrative_sections: [
    {
      title: '活动层结论',
      summary: '整体 ACOS 处于观察区间。',
      evidence: ['花费集中在前 3 个活动'],
      action: '保持',
      drill_to: 'budget',
    },
  ],
  items: makeCampaignItems(3),
}

const OVERVIEW_PAYLOAD = {
  project_id: 1,
  country: 'US',
  metrics: Array.from({ length: 6 }, (_, i) => ({
    label: `指标 ${i + 1}`,
    value: i,
    display_value: `$${(9876.54 + i * 37).toFixed(2)}`,
    helper: null,
  })),
  issue_cards: [],
  narrative_sections: [],
  comparison: {
    current_start: '2026-08-01',
    current_end: '2026-08-07',
    previous_start: '2026-07-25',
    previous_end: '2026-07-31',
    spend_change_ratio: 0.1234,
    clicks_change_ratio: -0.0567,
    sales_change_ratio: 0.089,
    orders_change_ratio: 0.012,
    cpc_change_ratio: 0.034,
    acos_change_ratio: -0.021,
    summary: '花费上升，销售同步上升。',
  },
  top_campaigns: [
    { campaign_name: LONG_CAMPAIGN, spend: 168.48, sales_7d: 512.4, orders_7d: 12, acos: 0.3288 },
  ],
  top_products: [],
  top_waste_terms: [],
  trend_summary: [],
  top_cross_sell_products: [],
}

const AD_RAW_ROWS = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  report_date: '2026-08-01',
  campaign_name: `${LONG_CAMPAIGN} #${i + 1}`,
  portfolio_name: 'portfolio-with-a-rather-long-name-for-width-tests',
  campaign_type: 'sponsoredProducts',
  targeting_type: 'auto',
  bidding_strategy: 'dynamic bids - down only',
  status: 'enabled',
  budget: 50,
  impressions: 12345,
  clicks: 234,
  ctr: 0.019,
  spend: 168.48,
  cpc: 0.72,
  orders_7d: 12,
  sales_7d: 512.4,
  acos: 0.3288,
  roas: 3.04,
  raw_row: { 广告活动名称: `${LONG_CAMPAIGN} #${i + 1}` },
}))

/** 页面级无整体横向滚动（允许 ±2px 误差） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const candidates = [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll('[class*="overflow-hidden"], #main-content')),
    ]
    return candidates.some((el) => el.scrollWidth - el.clientWidth > 2)
  })
  expect(overflow, '页面级容器不应出现横向溢出（表格内部横滑除外）').toBe(false)
}

async function mockAdBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/ad-analysis/campaigns**', (route) =>
    route.fulfill({ json: CAMPAIGNS_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/ad-analysis/overview**', (route) =>
    route.fulfill({ json: OVERVIEW_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/internal/ad-data/projects/1/ad-upload-files**', (route) =>
    route.fulfill({ json: [{ report_type: 'ad_campaign_report', ingestion_status: 'success' }] })
  )
  await page.route('**/api/backend/api/v1/internal/ad-data/projects/1/ad-campaigns-raw**', (route) =>
    route.fulfill({ json: { data: AD_RAW_ROWS, summary: { total_rows: AD_RAW_ROWS.length } } })
  )
}

// BLF-611 spec 是 mobile-only 用例（断言依赖 ~393px 视口）：默认随 Playwright 所有
// project 跑，chromium（Desktop Chrome 1280×720）下手机端断言会失败。
// 只在 mobile project 下运行；chromium/desktop project 下跳过（CI 的
// `--grep "@mobile-blf611"` 两个 project 都会命中，必须 skip 而非 fail）。
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'ad-mobile-blf611 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockAdBackend(page)
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

test.describe('@mobile-blf611 ad-analysis 手机端（BLF-611）', () => {
  test('活动页：汇总卡一行两个 + 手机卡片列表 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/campaigns?projectId=1&country=US')

    // 汇总卡：前两张同一行，第三张换行（grid-cols-2）
    const cards = page.locator('div.dashboard-surface', { hasText: '汇总指标' })
    await expect(cards.first()).toBeVisible({ timeout: 30000 })
    const boxes = []
    for (let i = 0; i < 6; i += 1) {
      const box = await cards.nth(i).boundingBox()
      if (box) boxes.push(box)
    }
    expect(boxes.length).toBeGreaterThanOrEqual(3)
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2)
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + 10)
    // 一张卡约半宽，不是被压成单列全宽
    const viewport = page.viewportSize()!
    expect(boxes[0].width).toBeLessThan(viewport.width * 0.7)

    // 表格区块（DeferredSection）：滚入视口后挂载；手机端为卡片列表（lg:hidden），桌面表格隐藏
    const tableSection = page.locator('[data-testid="campaigns-deferred-table"]')
    await tableSection.scrollIntoViewIfNeeded()
    const mobileCards = tableSection.locator('[class*="lg:hidden"] [class*="dashboard-surface"]')
    await expect(mobileCards.first()).toBeVisible({ timeout: 15000 })
    await expect(tableSection.locator('[class*="hidden lg:block"]')).toBeHidden()

    await expectNoPageHorizontalOverflow(page)
  })

  test('筛选区：手机端 2 列网格，日期范围独占一行', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/overview?projectId=1&country=US')

    // 等筛选区控件渲染（项目 Select 触发器）
    const toolbar = page.locator('div.dashboard-toolbar').first()
    await expect(toolbar).toBeVisible({ timeout: 30000 })

    const projectTrigger = toolbar.getByText('E2E 测试项目').first()
    const countryTrigger = toolbar.getByText('美国站 (US)').first()
    await expect(projectTrigger).toBeVisible({ timeout: 15000 })
    await expect(countryTrigger).toBeVisible({ timeout: 15000 })

    const projectBox = (await projectTrigger.boundingBox())!
    const countryBox = (await countryTrigger.boundingBox())!
    // 项目 / 国家同一行（2 列网格）
    expect(Math.abs(projectBox.y - countryBox.y)).toBeLessThan(2)

    // 日期范围按钮在下一行且占满整行
    const dateButton = toolbar.locator('button', { hasText: /日期|~|全部/ }).first()
    await expect(dateButton).toBeVisible()
    const dateBox = (await dateButton.boundingBox())!
    expect(dateBox.y).toBeGreaterThan(projectBox.y + 10)
    const viewport = page.viewportSize()!
    expect(dateBox.width).toBeGreaterThan(viewport.width * 0.75)

    await expectNoPageHorizontalOverflow(page)
  })

  test('桌面 1440：活动表格可见、汇总卡一行四个（零回归）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/advertising/ad-analysis/campaigns?projectId=1&country=US')

    const tableSection = page.locator('[data-testid="campaigns-deferred-table"]')
    await tableSection.scrollIntoViewIfNeeded()
    await expect(tableSection.locator('[class*="hidden lg:block"] table')).toBeVisible({
      timeout: 15000,
    })
    await expect(
      tableSection.locator('[class*="lg:hidden"] [class*="dashboard-surface"]').first()
    ).toBeHidden()

    const cards = page.locator('div.dashboard-surface', { hasText: '汇总指标' })
    const b0 = (await cards.nth(0).boundingBox())!
    const b3 = (await cards.nth(3).boundingBox())!
    expect(Math.abs(b0.y - b3.y)).toBeLessThan(2)
  })
})

test.describe('@mobile-blf611 ad-data 原始表手机端（BLF-611 规则 10）', () => {
  test('原始表保持列宽：容器内横滑、单元格不折行、页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-data?projectId=1&country=US')

    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('服务端总行数').first()).toBeVisible({ timeout: 15000 })

    // 表格内容宽度 > 容器可视宽度 → 由容器承接横滑（全局 max-content 兜底生效）
    const metrics = await table.evaluate((el) => {
      const wrapper = el.closest('[class*="overflow"]') as HTMLElement | null
      return {
        tableWidth: el.scrollWidth,
        wrapperClientWidth: wrapper?.clientWidth ?? 0,
        wrapperScrollWidth: wrapper?.scrollWidth ?? 0,
      }
    })
    expect(metrics.tableWidth).toBeGreaterThan(metrics.wrapperClientWidth)

    // 单元格不折行（whitespace-nowrap 生效，行高单行）；跳过展开按钮列（无文本列）
    const wraps = await table.evaluate((el) => {
      const tds = Array.from(el.querySelectorAll('tbody td:not(:has(button))')).slice(0, 20)
      return tds.filter((td) => {
        const style = window.getComputedStyle(td)
        return style.whiteSpace !== 'nowrap'
      }).length
    })
    expect(wraps).toBe(0)

    await expectNoPageHorizontalOverflow(page)
  })

  test('控制条：手机端报表类型/搜索全宽，视图切换与导出同行', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-data?projectId=1&country=US')

    // 报表类型 select：前两个 combobox 是顶部筛选区的项目/国家，第三个才是报表类型
    const reportSelect = page.getByRole('combobox').nth(2)
    await expect(reportSelect).toBeVisible({ timeout: 30000 })
    const selectBox = (await reportSelect.boundingBox())!
    const viewport = page.viewportSize()!
    expect(selectBox.width).toBeGreaterThan(viewport.width * 0.75)

    const searchInput = page.locator('input[placeholder*="按任意列内容过滤"]').first()
    await expect(searchInput).toBeVisible()
    const inputBox = (await searchInput.boundingBox())!
    expect(inputBox.width).toBeGreaterThan(viewport.width * 0.75)

    // 视图切换按钮与导出按钮在手机端同一行
    const rawModeButton = page.getByRole('button', { name: '原始明细' })
    const exportButton = page.getByRole('button', { name: /导出 CSV/ })
    await expect(rawModeButton).toBeVisible()
    await expect(exportButton).toBeVisible()
    const rawBox = (await rawModeButton.boundingBox())!
    const exportBox = (await exportButton.boundingBox())!
    expect(Math.abs(rawBox.y - exportBox.y)).toBeLessThan(2)
  })
})
