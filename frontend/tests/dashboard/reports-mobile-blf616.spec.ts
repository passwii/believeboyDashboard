import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-616 报表域A 手机端适配回归（定价测算 / 对账核对 / 产品分析 / 订单）。
 *
 * 自包含：session 与后端请求经 page.route mock，不依赖真实后端 / 登录态。
 * 默认随 mobile project（Pixel 5，393×851）跑；另加 360×800 小屏用例覆盖验收下界；
 * 桌面零回归用例在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 规则 2/9：控制台筛选项手机端 2 列网格（项目/站点同一行），桌面横向；
 * - 规则 4：对账核对详情弹窗汇总卡手机端纵向堆叠（grid-cols-1）；
 * - 规则 10：对账明细原生 <table> 包 overflow-x-auto（吃到全局 min-width: max-content
 *   兜底），页面无整体横向滚动；订单 12 列宽表同理（表格内部横滑）；
 * - 总则 1：定价测算「最近测算」卡手机端一行一个；
 * - 页面无整体横向滚动（仅表格/宽网格内部横滑）。
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

const PROJECTS = [{ id: 1, name: 'E2E 测试店铺' }]

/** 会话 + backend-base 基础 mock（所有用例共用） */
async function mockBase(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
}

/** 页面级无整体横向滚动（允许 ±2px 误差；排除表格内部横滑容器） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    const overflowHidden = Array.from(
      document.querySelectorAll('[class*="overflow-hidden"]')
    ).filter((el) => {
      const cls = String(el.className)
      if (/overflow-x-auto|overflow-auto|truncate/.test(cls)) return false
      if (el.querySelector('[class*="overflow-x-auto"], [class*="overflow-auto"]')) return false
      const rect = el.getBoundingClientRect()
      if (el.scrollWidth - el.clientWidth > 2) {
        const overflowers = Array.from(el.querySelectorAll('*')).filter((child) => {
          const cr = child.getBoundingClientRect()
          return cr.right > rect.right + 1 || cr.bottom > rect.bottom + 1
        })
        if (overflowers.length > 0) {
          const allAbsolute = overflowers.every((child) => {
            const pos = getComputedStyle(child).position
            return pos === 'absolute' || pos === 'fixed'
          })
          if (allAbsolute) return false
        }
      }
      return true
    })
    const candidates: Element[] = [document.documentElement, document.body, ...overflowHidden]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((el) => {
        // The Terminal header has an intentional horizontal scroller for its fixed filter set.
        if (el.closest('header')) return false
        return el.scrollWidth - el.clientWidth > 2
      })
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

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'reports-mobile-blf616 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockBase(page)
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

// ─────────────────────────────────────────────────────────────────────────────
// 对账核对（monthly-report/reconcile，原 report-reconciliation）
// ─────────────────────────────────────────────────────────────────────────────

test.describe('@mobile-blf616 对账核对 手机端（BLF-616）', () => {
  test('控制台筛选项 2 列网格 + 月报表格仅内部横滑 + 详情汇总卡纵向堆叠', async ({ page }) => {
    const RECONCILE_RESULT = {
      summary: {
        db_total_income: 12345.67,
        db_total_expense: 2345.6,
        db_net_amount: 10000.07,
        pdf_total_income: 12345.67,
        pdf_total_expense: 2345.6,
        pdf_net_amount: 10000.07,
      },
      total_items: 2,
      matched_items: 2,
      mismatched_items: 0,
      missing_items: 0,
      match_rate: 100,
      items: [
        {
          field_name: 'total_income',
          db_value: 12345.67,
          pdf_value: 12345.67,
          match: true,
          difference: 0,
          difference_percent: 0,
        },
        {
          field_name: 'total_expense',
          db_value: 2345.6,
          pdf_value: 2345.6,
          match: true,
          difference: 0,
          difference_percent: 0,
        },
      ],
      record_id: 1,
    }
    const REPORTS = [
      {
        report_id: 1,
        project_name: 'E2E 测试店铺',
        country: 'US',
        report_month: '2026-07',
        has_summary_pdf: true,
        pdf_url: null,
        pdf_uploaded_at: null,
        pt3_calculation_complete: true,
        pt4_calculation_complete: false,
        status: 'ready',
        has_transaction_csv: true,
        transaction_csv_missing: false,
      },
      {
        report_id: 2,
        project_name: 'E2E 测试店铺',
        country: 'DE',
        report_month: '2026-06',
        has_summary_pdf: false,
        pdf_url: null,
        pdf_uploaded_at: null,
        pt3_calculation_complete: false,
        pt4_calculation_complete: false,
        status: 'pending',
      },
    ]
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.route('**/api/backend/api/v1/report-reconciliation/available-reports**', (route) =>
      route.fulfill({ json: { reports: REPORTS } })
    )
    await page.route('**/api/backend/api/v1/report-reconciliation/auto-reconcile**', (route) =>
      route.fulfill({ json: RECONCILE_RESULT })
    )

    await page.goto('/dashboard/reports/monthly-report/reconcile')
    await expect(page.getByRole('heading', { name: '财务月报' })).toBeVisible({ timeout: 30000 })

    // 控制台筛选项：手机端 2 列网格 → 项目 / 站点 同一行（项目自动选中首项）
    const projectTrigger = page.getByText('E2E 测试店铺')
    const countryTrigger = page.getByText('美国站 (US)')
    await expect(projectTrigger).toBeVisible({ timeout: 30000 })
    await expect(countryTrigger).toBeVisible()
    await expect
      .poll(async () =>
        Math.abs((await projectTrigger.boundingBox())!.y - (await countryTrigger.boundingBox())!.y)
      )
      .toBeLessThan(2)
    const projectBox = (await projectTrigger.boundingBox())!
    const countryBox = (await countryTrigger.boundingBox())!
    expect(Math.abs(projectBox.y - countryBox.y), '手机端项目/站点应在同一行').toBeLessThan(2)
    const viewport = page.viewportSize()!
    expect(projectBox.width, '项目选择器手机端应占半列宽').toBeLessThan(viewport.width * 0.6)

    // 项目自动选中 → 月报表加载 → 原生 table 仅内部横滑，页面无整体横向滚动
    await expect(page.getByRole('heading', { name: '可核对月报' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('2026年07月')).toBeVisible()
    await expectNoPageHorizontalOverflow(page)

    // 点击可核对行 → 详情 Dialog → 汇总卡纵向堆叠（grid-cols-1），明细表内部横滑
    await page.getByText('2026年07月').click()
    await expect(page.getByText('收入合计')).toBeVisible({ timeout: 30000 })
    // 等 Dialog 入场动画结束再测坐标，避免动画中平移导致 y 漂移
    await page.waitForTimeout(700)
    const income = (await page.getByText('收入合计').boundingBox())!
    const expense = (await page.getByText('支出合计').boundingBox())!
    const net = (await page.getByText('净收款').boundingBox())!
    expect(expense.y, '手机端汇总卡应纵向堆叠（收入→支出）').toBeGreaterThan(income.y + 20)
    expect(net.y, '手机端汇总卡应纵向堆叠（支出→净收款）').toBeGreaterThan(expense.y + 20)
    await expect(page.getByText('匹配率 100%')).toBeVisible()
    await expect(page.getByText('合计收入').first()).toBeVisible({ timeout: 10000 })
    await expectNoPageHorizontalOverflow(page)
  })

  test('手动核对 tab：上传区单列 + 页面无横向滚动', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.goto('/dashboard/reports/monthly-report/reconcile')
    await expect(page.getByRole('heading', { name: '财务月报' })).toBeVisible({ timeout: 30000 })

    await page.getByRole('tab', { name: '手动核对' }).click()
    await expect(page.getByText('月度财务报表 (Excel)')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('月度结算摘要 (PDF)')).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 产品分析（product-analysis）
// ─────────────────────────────────────────────────────────────────────────────

test.describe('@mobile-blf616 产品分析 手机端（BLF-616）', () => {
  test('核算参数筛选项 2 列网格（日期全宽）+ 页面无横向滚动', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.goto('/dashboard/reports/product-analysis')
    await expect(page.getByRole('heading', { name: '核算参数' })).toBeVisible({ timeout: 30000 })

    // 项目 / 站点同一行；日期范围占整行（col-span-2）
    const projectTrigger = page.getByRole('combobox', { name: '项目' }).or(page.getByText('请选择项目')).first()
    const countryTrigger = page.getByRole('combobox', { name: '站点' }).or(page.getByText(/美国/)).first()
    await expect(projectTrigger).toBeVisible({ timeout: 30000 })
    await expect(countryTrigger).toBeVisible()
    await expect
      .poll(async () => Math.abs((await projectTrigger.boundingBox())!.y - (await countryTrigger.boundingBox())!.y))
      .toBeLessThan(2)
    const projectBox = (await projectTrigger.boundingBox())!
    const countryBox = (await countryTrigger.boundingBox())!
    expect(Math.abs(projectBox.y - countryBox.y), '手机端项目/站点应在同一行').toBeLessThan(2)

    // 日期范围整行（宽度 ≈ 视口 - 卡片 padding）
    const dateRange = page.getByLabel('开始日期').locator('../..').or(
      page.getByRole('button', { name: /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}|选择日期范围/ })
    )
    await expect(dateRange.first()).toBeVisible()
    const dateBox = (await dateRange.first().boundingBox())!
    expect(dateBox.width, '日期范围手机端应占整行').toBeGreaterThan(viewportWidth(page) * 0.8)

    await expectNoPageHorizontalOverflow(page)
  })
})

function viewportWidth(page: import('@playwright/test').Page): number {
  return page.viewportSize()!.width
}

// ─────────────────────────────────────────────────────────────────────────────
// 订单（order-info）
// ─────────────────────────────────────────────────────────────────────────────

test.describe('@mobile-blf616 订单信息 手机端（BLF-616）', () => {
  test('订单筛选常驻面板 + 12 列宽表仅内部横滑 + 页面无横向滚动', async ({ page }) => {
    const OVERVIEW = {
      items: [
        {
          id: 1,
          project_id: 1,
          project_name: 'E2E 测试店铺',
          brand_name: 'BELIEVEBOY',
          source_file_id: 99,
          purchase_at_utc: '2026-08-01T08:00:00Z',
          purchase_at_pt: '2026-07-31T21:00:00Z',
          purchase_date_pt: '2026-07-31',
          amazon_order_id: '111-3084457-1234567',
          order_status: 'Shipped',
          fulfillment_channel: 'AFN',
          fulfillment_label: 'FBA',
          ship_service_level: 'Expedited',
          sku: 'JDB-4341-29PCS',
          asin: 'B0C12345',
          product_name: '桌面置物架（加厚版）',
          quantity: 3,
          item_price: 19.99,
          shipping_price: 0,
          currency: 'USD',
          country: 'US',
          state: 'CA',
          city: 'Los Angeles',
          postal_code: '90001',
          is_counted_sales: true,
          created_at: '2026-08-01T08:00:00Z',
          carrier: null,
          tracking_no: null,
          shipped_at: null,
          updated_by: null,
          updated_at: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 50,
      stats: {
        total_orders: 1,
        total_quantity: 3,
        total_amount: 59.97,
        currency: 'USD',
        fba_count: 1,
        fbm_count: 0,
      },
    }
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.route('**/api/backend/api/v1/order-info/filter-options**', (route) =>
      route.fulfill({
        json: {
          projects: [{ value: '1', label: 'E2E 测试店铺' }],
          order_statuses: [{ value: 'Shipped', label: 'Shipped' }],
          fulfillment_channels: [{ value: 'AFN', label: 'FBA' }],
          countries: [],
          currencies: [{ value: 'USD', label: 'USD' }],
        },
      })
    )
    await page.route('**/api/backend/api/v1/order-info/overview**', (route) =>
      route.fulfill({ json: OVERVIEW })
    )

    await page.goto('/dashboard/reports/order-info')
    await expect(page.getByRole('heading', { name: '订单信息' })).toBeVisible({ timeout: 30000 })

    const orderPanel = page.getByRole('region', { name: '订单信息' })
    const filters = orderPanel.getByRole('group', { name: '订单筛选' })
    await expect(filters).toBeVisible()
    await expect(page.getByRole('button', { name: '切换页面筛选' })).toHaveCount(0)

    // 项目 / 站点 / 日期仍归全局 Header；订单页自己的六项筛选在面板内常驻可见。
    const selectors = filters.getByRole('combobox')
    await expect(selectors).toHaveCount(3)
    await expect(selectors.nth(0)).toContainText('类型')
    await expect(selectors.nth(1)).toContainText('状态')
    await expect(selectors.nth(2)).toContainText('币种')

    const typeBox = (await selectors.nth(0).boundingBox())!
    const statusBox = (await selectors.nth(1).boundingBox())!
    const currencyBox = (await selectors.nth(2).boundingBox())!
    expect(Math.abs(typeBox.y - statusBox.y), '类型与状态应位于两列首行').toBeLessThan(2)
    expect(statusBox.x).toBeGreaterThan(typeBox.x)
    expect(currencyBox.y).toBeGreaterThan(typeBox.y)

    for (const title of ['按订单号搜索', '按 SKU 搜索', '按 ASIN 搜索']) {
      const searchInput = filters.locator(`[title="${title}"]`)
      await expect(searchInput).toBeVisible()
      const bounds = (await searchInput.boundingBox())!
      if (title === '按订单号搜索') {
        expect(bounds.width, '订单号搜索在手机端独占一行').toBeGreaterThan(page.viewportSize()!.width * 0.75)
      }
    }

    // 数据行渲染，12+ 列宽表只在自己的滚动区域内横滑。
    await expect(page.getByText('111-3084457-1234567')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('JDB-4341-29PCS')).toBeVisible()
    const table = page.getByRole('table', { name: '订单列表' })
    const scrollRegion = table.locator('xpath=..')
    await expect(table).toBeVisible()
    const tableMetrics = await table.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.parentElement?.clientWidth ?? 0,
    }))
    expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth)
    await expect(table.locator('thead th').first()).toHaveClass(/bg-term-raised/)
    await expect(scrollRegion).toHaveClass(/overflow-auto/)
    await expectNoPageHorizontalOverflow(page)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 定价测算（pricing-calculation / new-product）
// ─────────────────────────────────────────────────────────────────────────────

test.describe('@mobile-blf616 新品定价测算 手机端（BLF-616）', () => {
  test('最近测算卡一行一个 + 卡片内 3 指标不溢出 + 页面无横向滚动', async ({ page }) => {
    const RUN = {
      id: 1,
      country: 'US',
      product_name: '桌面置物架（加厚版）E2E 长名称测试用例',
      calculation_type: 'profit_calc',
      project_id: 1,
      sku: 'JDB-4341-29PCS',
      package_length_cm: 30,
      package_width_cm: 20,
      package_height_cm: 10,
      weight_kg: 1.2,
      fob_product_cost_rmb: 12.5,
      first_leg_cost_rmb: 8.88,
      sale_price_usd: 19.99,
      commission_rate: 0.15,
      advertising_rate: 0.12,
      return_loss_rate: 0.04,
      storage_months: 1,
      inbound_placement_mode: 'single_destination',
      size_tier: 'SM',
      size_tier_label: '小号标准件',
      price_band: 'band_10_20',
      price_band_label: '$10-20',
      usd_to_rmb_rate: 7.2,
      usd_to_rmb_rate_source: 'system',
      fulfillment_fee_rule_label: '标准派送',
      inbound_config_fee_rule_label: '标准配置费',
      storage_fee_rule_label: '标准仓储费',
      dimensions: {
        longest_side_in: 11.8,
        middle_side_in: 7.9,
        shortest_side_in: 3.9,
        length_plus_girth_in: 27.6,
        volume_cubic_in: 366.1,
        volume_cubic_ft: 0.21,
      },
      weights: {
        product_weight_lb: 2.65,
        product_weight_oz: 42.3,
        dimensional_weight_lb: 2.1,
        chargeable_weight_lb: 2.65,
        chargeable_weight_oz: 42.3,
        chargeable_weight_rule: 'max(实重, 体积重)',
      },
      fees: {
        referral_fee_usd: 3.0,
        advertising_fee_usd: 2.4,
        return_loss_usd: 0.8,
        fba_fulfillment_fee_usd: 4.5,
        inbound_config_fee_usd: 0.35,
        storage_fee_usd: 0.2,
        total_fee_usd: 11.25,
      },
      profit: {
        ddp_cost_rmb: 21.38,
        ddp_cost_usd: 2.97,
        payout_usd: 16.3,
        profit_usd: 5.05,
        profit_rate: 0.2526,
      },
      warnings: [],
      created_by: 'E2E',
      created_at: '2026-08-01T08:00:00Z',
      updated_at: '2026-08-01T08:00:00Z',
    }
    await page.route('**/api/backend/api/v1/pricing-calculation/runs**', (route) =>
      route.fulfill({ json: { items: [RUN, { ...RUN, id: 2, product_name: '第二个测算结果' }], total: 2 } })
    )

    await page.goto('/dashboard/reports/pricing-calculation')
    // redirect → new-product
    await expect(page.getByText('测算输入')).toBeVisible({ timeout: 30000 })

    // 最近测算卡一行一个（grid-cols-1）
    await expect(page.getByText('最近测算')).toBeVisible({ timeout: 30000 })
    const card1 = page.getByText('桌面置物架（加厚版）E2E 长名称测试用例')
    await expect(card1).toBeVisible()
    const card2 = page.getByText('第二个测算结果')
    await expect(card2).toBeVisible()
    const b1 = (await card1.boundingBox())!
    const b2 = (await card2.boundingBox())!
    expect(b2.y, '手机端最近测算卡应一行一个（纵向堆叠）').toBeGreaterThan(b1.y + 40)

    // 卡片内 价格/利润/利润率 三指标可见且不溢出
    await expect(page.getByText('价格').first()).toBeVisible()
    await expect(page.getByText('利润').first()).toBeVisible()
    await expect(page.getByText('利润率').first()).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })
})
test.describe('@mobile-blf616 店铺测算站点选择器（BLF-994）', () => {
  test('站点按钮命中区域不应超出选择器高度', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.goto('/dashboard/reports/pricing-calculation/shop-calculation')

    const selector = page.getByRole('group', { name: '选择站点' })
    await expect(selector).toBeVisible({ timeout: 30000 })

    const buttons = selector.locator('button')
    const count = await buttons.count()
    expect(count).toBe(3)

    for (let index = 0; index < count; index++) {
      const button = buttons.nth(index)
      await button.hover()

      const bounds = await selector.evaluate((element) => {
        const container = element.getBoundingClientRect()
        const activeButton = document.querySelector('[aria-label="选择站点"] button:hover')
        if (!(activeButton instanceof HTMLElement)) {
          throw new Error('站点按钮 hover 状态未生效')
        }
        const rect = activeButton.getBoundingClientRect()
        return { container: { top: container.top, bottom: container.bottom }, button: { top: rect.top, bottom: rect.bottom } }
      })

      expect(bounds.button.top, 'hover 后站点按钮顶部不应超出选择器').toBeGreaterThanOrEqual(bounds.container.top)
      expect(bounds.button.bottom, 'hover 后站点按钮底部不应超出选择器').toBeLessThanOrEqual(bounds.container.bottom)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 360×800 小屏 + 桌面零回归
// ─────────────────────────────────────────────────────────────────────────────

test.describe('@mobile-blf616 小屏 / 桌面回归（BLF-616）', () => {
  test('360×800：对账控制台 2 列 + 无整体横向滚动', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.route('**/api/backend/api/v1/report-reconciliation/available-reports**', (route) =>
      route.fulfill({ json: { reports: [] } })
    )
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/reports/monthly-report/reconcile')
    await expect(page.getByRole('heading', { name: '财务月报' })).toBeVisible({ timeout: 30000 })
    const projectTrigger = page.getByText('E2E 测试店铺')
    const countryTrigger = page.getByText('美国站 (US)')
    await expect(projectTrigger).toBeVisible({ timeout: 30000 })
    await expect(countryTrigger).toBeVisible()
    await expect
      .poll(async () =>
        Math.abs((await projectTrigger.boundingBox())!.y - (await countryTrigger.boundingBox())!.y)
      )
      .toBeLessThan(2)
    const projectBox = (await projectTrigger.boundingBox())!
    const countryBox = (await countryTrigger.boundingBox())!
    expect(Math.abs(projectBox.y - countryBox.y), '360px 小屏项目/站点仍应在同一行').toBeLessThan(2)
    await expectNoPageHorizontalOverflow(page)
  })

  test('1440：产品分析筛选项横向排列（项目/日期同行）', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: PROJECTS })
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/reports/product-analysis')
    const projectTrigger = page.getByRole('combobox', { name: '项目' }).or(page.getByText('请选择项目'))
    await expect(projectTrigger.first()).toBeVisible({ timeout: 30000 })
    const dateBtn = page.getByLabel('开始日期').or(
      page.getByRole('button', {
        name: /\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}|选择日期范围/,
      })
    )
    await expect
      .poll(async () => Math.abs((await projectTrigger.first().boundingBox())!.y - (await dateBtn.first().boundingBox())!.y))
      .toBeLessThan(6)
    const projectBox = (await projectTrigger.first().boundingBox())!
    const dateBox = (await dateBtn.first().boundingBox())!
    expect(Math.abs(projectBox.y - dateBox.y), '1440 桌面筛选项应在同一行').toBeLessThan(6)
  })
})
