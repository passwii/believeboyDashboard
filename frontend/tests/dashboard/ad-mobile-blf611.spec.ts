import { test, expect } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

/**
 * 广告域手机端回归（BLF-611 建立，BLF-1509 Stage 6 按 V4 Warm Ledger 重写）。
 *
 * 自包含：session、项目列表、10 个 ad-analysis 端点与 ad-data 原始表全部经
 * page.route mock，不依赖真实后端 / 登录态。默认随 mobile project（Pixel 5，
 * 393×851）跑；320px 下界与 1440×900 桌面零回归在测试内切视口。
 *
 * 覆盖验收：
 * - KPI/汇总卡手机端一行两个，桌面保持原列数；
 * - 概览图表手机端纵向堆叠，桌面双列；
 * - 表格保留全部列、在自身容器内横滑，页面无整体横向溢出；
 * - 筛选条手机端可展开，项目/站点/日期范围整行，开始/结束日期并排；
 * - 子页 Tab 可横滑，深链进入末位 Tab 时激活项自动滚入可视区；
 * - ad-data 控制条单列、分页纵向堆叠、原始表容器内横滑。
 */

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', fullName: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [{ id: 1, name: 'E2E 测试项目' }]
const LONG_CAMPAIGN =
  'SP - Auto - US - 超长活动名称用来验证手机端布局不会被长文本撑破视口造成页面整体横向滚动 - 2026 - 001'

function summaryCards(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    label: `汇总指标 ${index + 1}`,
    value: `$${(12345.67 + index * 111).toFixed(2)}`,
    helper: '较上周期 +1.23%',
  }))
}

const NARRATIVE = [
  {
    title: '活动层结论',
    summary: '整体 ACOS 处于观察区间。',
    evidence: ['花费集中在前 3 个活动'],
    action: '保持',
    drill_to: 'budget',
  },
]

function campaignItem(index: number) {
  return {
    campaign_name: `${LONG_CAMPAIGN} #${index + 1}`,
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
  }
}

function budgetItem(index: number) {
  return {
    campaign_name: `${LONG_CAMPAIGN} #${index + 1}`,
    status: '投放中',
    budget: 50,
    suggested_budget: 62.5,
    budget_gap: 12.5,
    budget_utilization_rate: 0.91,
    missed_impressions_min: 100,
    missed_impressions_max: 240,
    missed_clicks_min: 4,
    missed_clicks_max: 9,
    missed_sales_min: 20.5,
    missed_sales_max: 88.8,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    acos: 0.3288,
    action: '加预算',
    next_step: '优先观察搜索词结构',
  }
}

function placementItem(index: number) {
  return {
    campaign_name: `${LONG_CAMPAIGN} #${index + 1}`,
    placement: 'Top of Search',
    impressions: 12345,
    clicks: 234,
    ctr: 0.019,
    cpc: 0.72,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    units_7d: 14,
    cvr_7d: 0.051,
    acos: 0.3288,
    roas: 3.04,
    action: '保持',
    next_step: '观察首页首位效率',
  }
}

function productItem(index: number) {
  return {
    ad_sku: `SKU-${index + 1}-LONG-NAME`,
    ad_asin: `B0${index + 1}ABCDEFG`,
    campaign_count: 3,
    primary_campaign: LONG_CAMPAIGN,
    impressions: 12345,
    clicks: 234,
    ctr: 0.019,
    cpc: 0.72,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    units_7d: 14,
    cvr_7d: 0.051,
    acos: 0.3288,
    grade: 'A',
    cross_sell_asin_count: 2,
    cross_sell_orders_7d: 3,
    cross_sell_sales_7d: 96.2,
    top_purchased_asin: 'B0OTHER123',
    cross_sell_action: '观察',
    next_action: '保持投放并小步加预算',
  }
}

function purchasedProductItem(index: number) {
  return {
    purchased_asin: `B0${index + 1}PURCHASED`,
    ad_sku: `SKU-${index + 1}-LONG-NAME`,
    campaign_count: 2,
    other_sku_units_7d: 3,
    other_sku_orders_7d: 2,
    other_sku_sales_7d: 96.2,
    action: '观察',
  }
}

function searchTermItem(index: number) {
  return {
    search_term: `long search term for mobile width checks ${index + 1}`,
    match_type: 'BROAD',
    campaign_count: 2,
    primary_campaign: LONG_CAMPAIGN,
    impressions: 12345,
    clicks: 234,
    ctr: 0.019,
    cpc: 0.72,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    cvr_7d: 0.051,
    acos: 0.3288,
    impression_share: 0.12,
    impression_rank: 8,
    action: '加词',
  }
}

function targetItem(index: number) {
  return {
    target_text: `asin="B0TARGET${index + 1}"`,
    match_type: 'EXACT',
    campaign_count: 2,
    primary_campaign: LONG_CAMPAIGN,
    impressions: 12345,
    clicks: 234,
    ctr: 0.019,
    cpc: 0.72,
    spend: 168.48,
    sales_7d: 512.4,
    orders_7d: 12,
    cvr_7d: 0.051,
    acos: 0.3288,
    top_of_search_impression_share: 0.18,
    action: '保持',
  }
}

function trafficItem(index: number) {
  return {
    campaign_name: `${LONG_CAMPAIGN} #${index + 1}`,
    status: '投放中',
    total_impressions: 12345,
    valid_impressions: 12000,
    invalid_impressions: 345,
    invalid_impression_rate: 0.028,
    total_clicks: 234,
    valid_clicks: 228,
    invalid_clicks: 6,
    invalid_click_rate: 0.026,
    risk_level: '低风险',
    next_step: '继续观察',
  }
}

const OVERVIEW_PAYLOAD = {
  project_id: 1,
  country: 'US',
  metrics: [
    { label: 'Spend', value: 9876.54, display_value: '$9,876.54', helper: null },
    { label: 'Sales 7d', value: 32000, display_value: '$32,000.00', helper: null },
    { label: 'Orders 7d', value: 120, display_value: '120', helper: null },
    { label: 'ACOS', value: 0.31, display_value: '31.00%', helper: null },
    { label: 'ROAS', value: 3.24, display_value: '3.24', helper: null },
    { label: 'CTR', value: 0.019, display_value: '1.90%', helper: null },
    { label: 'CPC', value: 0.72, display_value: '$0.72', helper: null },
    { label: 'Clicks', value: 234, display_value: '234', helper: null },
  ],
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
  top_products: [
    { ad_sku: 'SKU-1-LONG-NAME', spend: 120.5, sales_7d: 400.2, orders_7d: 9, acos: 0.301 },
  ],
  top_waste_terms: [
    { search_term: 'waste term', spend: 18.2, sales_7d: 0, orders_7d: 0, clicks: 20 },
  ],
  trend_summary: [
    { report_date: '2026-08-01', spend: 1200, sales_7d: 4200, clicks: 300, cpc: 0.7 },
    { report_date: '2026-08-02', spend: 1350, sales_7d: 4550, clicks: 320, cpc: 0.72 },
  ],
  top_cross_sell_products: [
    {
      ad_sku: 'SKU-1-LONG-NAME',
      purchased_asin: 'B0OTHER123',
      other_sku_sales_7d: 96.2,
      other_sku_orders_7d: 3,
    },
  ],
}

const CAMPAIGNS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  summary_cards: summaryCards(6),
  narrative_sections: NARRATIVE,
  items: [campaignItem(0), campaignItem(1), campaignItem(2)],
}

const TIME_TREND_PAYLOAD = {
  project_id: 1,
  country: 'US',
  summary: [
    { report_date: '2026-08-01', clicks: 210, spend: 1200, cpc: 0.7, running_spend: 1200 },
    { report_date: '2026-08-02', clicks: 234, spend: 1350, cpc: 0.72, running_spend: 2550 },
    { report_date: '2026-08-03', clicks: 228, spend: 1290, cpc: 0.71, running_spend: 3840 },
  ],
  comparison: {
    current_start: '2026-08-01',
    current_end: '2026-08-03',
    previous_start: '2026-07-29',
    previous_end: '2026-07-31',
    spend_change_ratio: 0.12,
    clicks_change_ratio: -0.05,
    cpc_change_ratio: 0.03,
    summary: '花费小幅上升。',
  },
}

const AD_RAW_ROWS = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  report_start_date: '2026-08-01',
  report_end_date: '2026-08-07',
  campaign_name: `${LONG_CAMPAIGN} #${index + 1}`,
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
  raw_row: { 广告活动名称: `${LONG_CAMPAIGN} #${index + 1}` },
}))

function payloadForAdAnalysis(pathname: string) {
  if (pathname.endsWith('/overview')) return OVERVIEW_PAYLOAD
  if (pathname.endsWith('/campaigns')) return CAMPAIGNS_PAYLOAD
  if (pathname.endsWith('/time-trend')) return TIME_TREND_PAYLOAD
  if (pathname.endsWith('/purchased-products')) {
    return {
      project_id: 1,
      country: 'US',
      items: [purchasedProductItem(0), purchasedProductItem(1)],
    }
  }
  if (pathname.endsWith('/products')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      items: [productItem(0), productItem(1)],
    }
  }
  if (pathname.endsWith('/placements')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      narrative_sections: NARRATIVE,
      items: [placementItem(0), placementItem(1)],
    }
  }
  if (pathname.endsWith('/search-terms')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      narrative_sections: NARRATIVE,
      items: [searchTermItem(0), searchTermItem(1)],
    }
  }
  if (pathname.endsWith('/targets')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      items: [targetItem(0), targetItem(1)],
    }
  }
  if (pathname.endsWith('/budget')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      narrative_sections: NARRATIVE,
      items: [budgetItem(0), budgetItem(1)],
    }
  }
  if (pathname.endsWith('/traffic-quality')) {
    return {
      project_id: 1,
      country: 'US',
      summary_cards: summaryCards(4),
      narrative_sections: NARRATIVE,
      items: [trafficItem(0), trafficItem(1)],
    }
  }
  return { project_id: 1, country: 'US' }
}

async function mockAdBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/ad-analysis/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    route.fulfill({ json: payloadForAdAnalysis(pathname) })
  })
  await page.route(
    '**/api/backend/api/v1/internal/ad-data/projects/1/ad-upload-files**',
    (route) =>
      route.fulfill({
        json: [{ report_type: 'ad_campaign_report', ingestion_status: 'success' }],
      })
  )
  await page.route(
    '**/api/backend/api/v1/internal/ad-data/projects/1/ad-campaigns-raw**',
    (route) =>
      route.fulfill({
        json: { data: AD_RAW_ROWS, summary: { total_rows: AD_RAW_ROWS.length } },
      })
  )
}

/** 页面级无整体横向滚动（表格/图表自身滚动容器除外） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    const candidates: HTMLElement[] = [document.documentElement, document.body]
    const main = document.querySelector<HTMLElement>('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((element) => element.scrollWidth - element.clientWidth > 2)
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className).slice(0, 120),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
  })
  expect(offenders, '页面级容器不应出现横向溢出').toEqual([])
}

async function expectWideTableScroller(page: import('@playwright/test').Page) {
  const wrapper = page.locator('[data-warm-table-scroll="true"]').first()
  await wrapper.scrollIntoViewIfNeeded()
  await expect(wrapper).toBeVisible()
  const metrics = await wrapper.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    tableWidth: element.querySelector('table')?.getBoundingClientRect().width ?? 0,
  }))
  expect(metrics.tableWidth).toBeGreaterThan(metrics.clientWidth + 2)
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth + 2)
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'ad-mobile-blf611 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockAdBackend(page)
  await addBLF611FixtureAuth(context)
})

test.describe('@mobile-blf611 广告分析 手机端（BLF-1509）', () => {
  test('活动页：汇总卡一行两个、宽表仅容器内横滑、页面无横向溢出', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/campaigns?projectId=1&country=US')

    const cards = page.locator(
      '[data-warm-ad-analysis-page="campaigns"] [class*="kpiTile"]'
    )
    await expect(cards.first()).toBeVisible({ timeout: 30000 })
    await expect(cards).toHaveCount(6)

    const firstBox = (await cards.nth(0).boundingBox())!
    const secondBox = (await cards.nth(1).boundingBox())!
    const thirdBox = (await cards.nth(2).boundingBox())!
    expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(2)
    expect(thirdBox.y).toBeGreaterThan(firstBox.y + 10)
    expect(firstBox.width).toBeLessThan(page.viewportSize()!.width * 0.7)

    const stripBox = (await page.getByTestId('terminal-mobile-strip').boundingBox())!
    const tabBox = (await page.locator('[data-warm-tablist]').boundingBox())!
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(tabBox.y + 1)

    const tableSection = page.locator('[data-testid="campaigns-deferred-table"]')
    await tableSection.scrollIntoViewIfNeeded()
    await expect(tableSection.locator('table')).toBeVisible({ timeout: 15000 })
    await expectWideTableScroller(page)
    await expectNoPageHorizontalOverflow(page)
  })

  test('概览：8 个指标两列排布、图表纵向堆叠、明细表内横滑', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/overview?projectId=1&country=US')
    await expect(page.locator('[data-warm-ad-analysis-page="overview"]')).toBeVisible({
      timeout: 30000,
    })

    const metrics = page.locator(
      '[data-warm-ad-analysis-page="overview"] [class*="metricTile"]'
    )
    await expect(metrics).toHaveCount(8)
    const metricBoxes = await Promise.all(
      [0, 1, 2].map(async (index) => (await metrics.nth(index).boundingBox())!)
    )
    expect(Math.abs(metricBoxes[0].y - metricBoxes[1].y)).toBeLessThan(2)
    expect(metricBoxes[2].y).toBeGreaterThan(metricBoxes[0].y + 10)

    const trendPanel = page.getByRole('region', { name: '按日花费与销售额' })
    const campaignPanel = page.getByRole('region', { name: '活动花费' })
    await expect(trendPanel).toBeVisible()
    await expect(campaignPanel).toBeVisible()
    const trendBox = (await trendPanel.boundingBox())!
    const campaignBox = (await campaignPanel.boundingBox())!
    expect(campaignBox.y).toBeGreaterThan(trendBox.y + 100)
    expect(trendBox.height).toBeGreaterThan(200)

    await expectWideTableScroller(page)
    await expectNoPageHorizontalOverflow(page)
  })

  test('筛选条：展开后项目/站点/日期整行，开始与结束日期并排', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/overview?projectId=1&country=US')

    const filterToggle = page.getByRole('button', { name: '切换页面筛选' })
    await expect(filterToggle).toBeVisible({ timeout: 30000 })
    await expect(filterToggle).toContainText('E2E 测试项目')
    await filterToggle.click()
    await expect(filterToggle).toHaveAttribute('aria-expanded', 'true')

    const toolbar = page.getByTestId('mobile-filter-strip-grid')
    const projectSelect = toolbar.getByRole('combobox', { name: '项目筛选' })
    const countrySelect = toolbar.getByRole('combobox', { name: '站点筛选' })
    const datePreset = toolbar.getByRole('combobox', { name: '日期快捷范围' })
    const dateStart = toolbar.getByLabel('开始日期')
    const dateEnd = toolbar.getByLabel('结束日期')
    await expect(projectSelect).toBeVisible({ timeout: 15000 })
    await expect(countrySelect).toBeVisible()
    await expect(datePreset).toBeVisible()
    await expect(dateStart).toBeVisible()
    await expect(dateEnd).toBeVisible()

    const gridColumns = await toolbar.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length
    )
    expect(gridColumns).toBe(2)

    const viewport = page.viewportSize()!
    const projectBox = (await projectSelect.boundingBox())!
    const countryBox = (await countrySelect.boundingBox())!
    const datePresetBox = (await datePreset.boundingBox())!
    const startBox = (await dateStart.boundingBox())!
    const endBox = (await dateEnd.boundingBox())!
    expect(projectBox.width).toBeGreaterThan(viewport.width * 0.75)
    expect(countryBox.width).toBeGreaterThan(viewport.width * 0.75)
    expect(datePresetBox.width).toBeGreaterThan(viewport.width * 0.75)
    expect(countryBox.y).toBeGreaterThan(projectBox.y + 10)
    expect(datePresetBox.y).toBeGreaterThan(countryBox.y + 10)
    expect(Math.abs(startBox.y - endBox.y)).toBeLessThan(2)
    expect(startBox.width).toBeLessThan(viewport.width * 0.6)
    await expectNoPageHorizontalOverflow(page)
  })

  test('子页 Tab：深链到末位页面时激活项自动滚入可视区', async ({ page }) => {
    await page.goto(
      '/dashboard/advertising/ad-analysis/traffic-quality?projectId=1&country=US'
    )
    const tablist = page.getByRole('navigation', { name: '广告分析子页面' })
    await expect(tablist).toBeVisible({ timeout: 30000 })
    const active = tablist.getByRole('link', { name: '流量质量' })
    await expect(active).toHaveAttribute('aria-current', 'page')

    const visible = await tablist.evaluate((nav) => {
      const scroller = nav.parentElement as HTMLElement
      const activeLink = nav.querySelector<HTMLElement>('[aria-current="page"]')
      if (!activeLink) return false
      const scrollerRect = scroller.getBoundingClientRect()
      const activeRect = activeLink.getBoundingClientRect()
      return (
        activeRect.left >= scrollerRect.left - 1 &&
        activeRect.right <= scrollerRect.right + 1
      )
    })
    expect(visible, '激活 Tab 应自动滚入横向可视区').toBe(true)
    await expectNoPageHorizontalOverflow(page)
  })

  test('其余 8 个分析页：KPI 两列、无页面级横向溢出', async ({ page }) => {
    const pages = [
      ['budget', 4],
      ['placements', 4],
      ['products', 4],
      ['search-terms', 4],
      ['targets', 4],
      ['time-trend', 3],
      ['traffic-quality', 4],
      ['purchased-products', 0],
    ] as const

    for (const [slug, metricCount] of pages) {
      await page.goto(`/dashboard/advertising/ad-analysis/${slug}?projectId=1&country=US`)
      const pageMarker = page.locator(`[data-warm-ad-analysis-page="${slug}"]`)
      await expect(pageMarker).toBeVisible({ timeout: 30000 })

      if (metricCount > 0) {
        const cards = pageMarker.locator('[class*="kpiTile"]')
        await expect(cards).toHaveCount(metricCount)
        const firstBox = (await cards.nth(0).boundingBox())!
        const secondBox = (await cards.nth(1).boundingBox())!
        expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(2)
        if (metricCount > 2) {
          const thirdBox = (await cards.nth(2).boundingBox())!
          expect(thirdBox.y).toBeGreaterThan(firstBox.y + 10)
        }
      }

      await expectNoPageHorizontalOverflow(page)
    }
  })

  test('320px 下界：概览指标两列、图表堆叠、无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/dashboard/advertising/ad-analysis/overview?projectId=1&country=US')
    await expect(page.locator('[data-warm-ad-analysis-page="overview"]')).toBeVisible({
      timeout: 30000,
    })

    const metrics = page.locator(
      '[data-warm-ad-analysis-page="overview"] [class*="metricTile"]'
    )
    const firstBox = (await metrics.nth(0).boundingBox())!
    const secondBox = (await metrics.nth(1).boundingBox())!
    expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(2)
    expect(firstBox.width).toBeGreaterThan(100)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf611 ad-data 手机端（BLF-1509）', () => {
  test('控制条单列、原始表容器内横滑、分页纵向堆叠', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-data?projectId=1&country=US')
    const controls = page.locator('[data-warm-ad-data-controls]')
    await expect(controls).toBeVisible({ timeout: 30000 })
    const tableWrapper = page.locator('[data-ad-data-table-scroll="true"]')
    await expect(tableWrapper).toBeVisible({ timeout: 30000 })

    const viewport = page.viewportSize()!
    const reportTrigger = controls.locator('button[aria-label="报表类型"]')
    const searchInput = controls.getByLabel('搜索广告数据')
    await expect(reportTrigger).toBeVisible()
    await expect(searchInput).toBeVisible()
    const reportBox = await reportTrigger.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      y: element.getBoundingClientRect().y,
    }))
    const searchBox = await searchInput.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      y: element.getBoundingClientRect().y,
    }))
    expect(reportBox.width).toBeGreaterThan(viewport.width * 0.75)
    expect(searchBox.width).toBeGreaterThan(viewport.width * 0.75)
    expect(searchBox.y).toBeGreaterThan(reportBox.y + 10)

    const rawMode = controls.getByRole('button', { name: '原始明细' })
    const exportButton = controls.getByRole('button', { name: /导出 CSV/ })
    const rawBox = await rawMode.evaluate((element) => ({
      y: element.getBoundingClientRect().y,
      height: element.getBoundingClientRect().height,
    }))
    const exportBox = await exportButton.evaluate((element) => ({
      y: element.getBoundingClientRect().y,
      height: element.getBoundingClientRect().height,
    }))
    expect(Math.abs(rawBox.y + rawBox.height - (exportBox.y + exportBox.height))).toBeLessThan(10)

    await tableWrapper.scrollIntoViewIfNeeded()
    await expect(tableWrapper).toBeVisible()
    const tableMetrics = await tableWrapper.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      tableWidth: element.querySelector('table')?.getBoundingClientRect().width ?? 0,
    }))
    expect(tableMetrics.tableWidth).toBeGreaterThan(tableMetrics.clientWidth + 2)
    expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth + 2)

    const prevButton = page.getByRole('button', { name: '上一页' })
    const nextButton = page.getByRole('button', { name: '下一页' })
    const prevBox = await prevButton.evaluate((element) => ({
      y: element.getBoundingClientRect().y,
      height: element.getBoundingClientRect().height,
    }))
    const nextBox = await nextButton.evaluate((element) => ({
      y: element.getBoundingClientRect().y,
      height: element.getBoundingClientRect().height,
    }))
    expect(prevBox.height).toBeGreaterThanOrEqual(44)
    expect(nextBox.height).toBeGreaterThanOrEqual(44)
    expect(Math.abs(prevBox.y - nextBox.y)).toBeLessThan(2)

    const pageSize = page.getByText('每页', { exact: true })
    const pageSizeBox = await pageSize.evaluate((element) => ({
      y: element.getBoundingClientRect().y,
    }))
    expect(prevBox.y).toBeGreaterThan(pageSizeBox.y + 10)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf611 桌面零回归（BLF-1509）', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test('活动页：汇总卡一行四个、完整表格可见', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/campaigns?projectId=1&country=US')
    const cards = page.locator(
      '[data-warm-ad-analysis-page="campaigns"] [class*="kpiTile"]'
    )
    await expect(cards.first()).toBeVisible({ timeout: 30000 })
    const boxes = await Promise.all(
      [0, 1, 2, 3].map(async (index) => (await cards.nth(index).boundingBox())!)
    )
    for (const box of boxes.slice(1)) {
      expect(Math.abs(box.y - boxes[0].y)).toBeLessThan(2)
    }

    const tableSection = page.locator('[data-testid="campaigns-deferred-table"]')
    await tableSection.scrollIntoViewIfNeeded()
    await expect(tableSection.locator('table')).toBeVisible({ timeout: 15000 })
  })

  test('概览：8 个指标一行、图表并排', async ({ page }) => {
    await page.goto('/dashboard/advertising/ad-analysis/overview?projectId=1&country=US')
    await expect(page.locator('[data-warm-ad-analysis-page="overview"]')).toBeVisible({
      timeout: 30000,
    })
    const metrics = page.locator(
      '[data-warm-ad-analysis-page="overview"] [class*="metricTile"]'
    )
    const boxes = await Promise.all(
      [0, 1, 2, 7].map(async (index) => (await metrics.nth(index).boundingBox())!)
    )
    for (const box of boxes.slice(1)) {
      expect(Math.abs(box.y - boxes[0].y)).toBeLessThan(2)
    }

    const trendBox = (await page
      .getByRole('region', { name: '按日花费与销售额' })
      .boundingBox())!
    const campaignBox = (await page.getByRole('region', { name: '活动花费' }).boundingBox())!
    expect(Math.abs(trendBox.y - campaignBox.y)).toBeLessThan(2)
    expect(campaignBox.x).toBeGreaterThan(trendBox.x + 100)
  })
})
