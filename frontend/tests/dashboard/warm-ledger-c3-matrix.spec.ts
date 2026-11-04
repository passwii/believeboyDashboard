import { expect, test, type Page, type Request } from '@playwright/test'

import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const VIEWPORT = { width: 1440, height: 900 } as const
const STAGE_INSET = 8

const ROUTES = {
  orderInfo: '/dashboard/reports/order-info',
  productAnalysis: '/dashboard/reports/product-analysis',
  monthlyDisplay: '/dashboard/reports/monthly-report/display',
} as const

const PROJECTS = [
  { id: 1, name: 'C3 Fixture Store' },
  { id: 2, name: 'C3 Second Store' },
]

const SESSION = {
  user: {
    id: '1',
    name: 'E2E',
    fullName: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    isAdmin: true,
  },
  expires: '2099-01-01T00:00:00.000Z',
}

type ApiRequestAudit = {
  method: string
  pathname: string
  url: string
  body: unknown
}

type ApiAudit = {
  requests: ApiRequestAudit[]
  unhandled: string[]
}

function requestBody(request: Request): unknown {
  const raw = request.postData()
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

const ORDER_ITEM = {
  id: 101,
  project_id: 1,
  project_name: 'C3 Fixture Store',
  brand_name: null,
  source_file_id: 1,
  purchase_at_utc: '2026-10-20T02:30:00Z',
  purchase_at_pt: '2026-10-19 19:30:00',
  purchase_date_pt: '2026-10-19',
  amazon_order_id: '111-3333333-0000001',
  order_status: 'Pending',
  fulfillment_channel: 'Merchant',
  fulfillment_label: 'FBM',
  ship_service_level: null,
  sku: 'C3-SKU-0001',
  asin: 'B0C3FIXTURE',
  product_name: 'C3 fixture order product',
  quantity: 2,
  item_price: 25,
  shipping_price: 5,
  currency: 'USD',
  country: 'US',
  state: 'CA',
  city: 'Los Angeles',
  postal_code: '90001',
  is_counted_sales: true,
  created_at: '2026-10-20T03:00:00Z',
  carrier: null,
  tracking_no: null,
  shipped_at: null,
  updated_by: null,
  updated_at: null,
}

const ORDER_STATS = {
  total_orders: 51,
  total_quantity: 102,
  total_amount: 1530,
  currency: 'USD',
  fba_count: 0,
  fbm_count: 51,
}

const PAGED_ORDER_ITEM = {
  ...ORDER_ITEM,
  id: 201,
  amazon_order_id: '111-3333333-0000051',
}

const PRODUCT_AVAILABILITY = {
  business_report_missing: [],
  ad_report_missing: [],
  inventory_missing: [],
  business_period_info: [],
  ad_period_info: [],
  business_periodic_only_missing: [],
  ad_periodic_only_missing: [],
  payment_periods_overlapping: [],
  payment_full_period_covered: true,
  payment_daily_covered_dates: [],
  payment_objective_empty_dates: [],
  has_minimum_data: true,
  weekly_availability: [],
}

const PRODUCT_RUN_RESULT = {
  project_id: 1,
  project_name: 'C3 Fixture Store',
  country: 'US',
  total_periods: 1,
  periods: [
    {
      report_start_date: '2026-10-19',
      report_end_date: '2026-10-25',
      summary: {
        总销售额: 1250,
        总销量: 25,
        实际销售额: 1200,
        利润: 240,
        利润率: 0.192,
        广告花费: 90,
        ACOS: 0.075,
        CPC: 0.45,
        页面浏览量: 4200,
        总访客: 1800,
        总转化: 0.12,
      },
      details: [
        {
          SKU: 'C3-SKU-0001',
          ASIN: 'B0C3FIXTURE',
          总销量: 25,
          总销售额: 1250,
          广告花费: 90,
          广告销售额: 500,
          ACOS: 0.18,
          利润: 240,
          利润率: 0.192,
        },
      ],
      persisted: true,
    },
  ],
}

function recognitionFor(body: string, sequence: number) {
  if (body.includes('business.csv')) {
    return recognition('business_report', `business-temp-${sequence}`)
  }
  if (body.includes('payment.csv')) {
    return recognition('payment_report', `payment-temp-${sequence}`)
  }
  return recognition('ad_promoted_product_report', `ad-temp-${sequence}`)
}

function recognition(reportType: string, tempFileId: string) {
  const fileStem = tempFileId.split('-temp-')[0]
  return {
    temp_file_id: tempFileId,
    original_filename:
      fileStem === 'ad' ? 'ad.xlsx' : `${fileStem}.csv`,
    extension: fileStem === 'ad' ? 'xlsx' : 'csv',
    report_type: reportType,
    matched_columns: [],
    reason: '',
    status: 'recognized',
    country: 'US',
    detected_countries: ['US'],
    primary_country: 'US',
    date_input_mode: 'single_auto',
    detected_date: '2026-10-20',
    detected_start_date: null,
    detected_end_date: null,
    project_match: {
      status: 'matched',
      project_name: PROJECTS[0].name,
      candidate_projects: [],
      matched_by: 'ASIN',
      matched_values: [],
      message: null,
    },
    row_count_preview: 10,
    warnings: [],
  }
}

function financialRow(month: string, currencyCode: 'USD' | 'EUR' | 'GBP') {
  return {
    report_month: month,
    income_sales: 1000,
    income_refund: -20,
    income_adjustment: 0,
    income_other: 26,
    expense_selling_fee: -100,
    expense_fba_fee: -70,
    expense_inventory_fee: -20,
    expense_service_fee: -10,
    expense_advertising: -80,
    expense_other_fees: -20,
    income_total: 1006,
    expense_total: -300,
    amazon_pay_back: 706,
    income_vat_total: 0,
    income_sales_with_tax: 1000,
    expense_vat_total: 0,
    credit_card_deduction_usd: -5,
    fob_cost_rmb: 1800,
    first_leg_cost_rmb: 200,
    has_source_report: true,
    currency_code: currencyCode,
  }
}

function financialPayload(url: URL, country: 'USD' | 'EUR' | 'GBP') {
  const requestedProjectId = Number(url.searchParams.get('project_id') ?? PROJECTS[0].id)
  const start = url.searchParams.get('start_month') ?? '2025-10'
  const end = url.searchParams.get('end_month') ?? '2026-09'
  const rows = ['2026-08', '2026-09']
    .filter((month) => month >= start && month <= end)
    .map((month) => financialRow(month, country))

  return {
    project_id: requestedProjectId,
    project_name:
      PROJECTS.find((project) => project.id === requestedProjectId)?.name ?? PROJECTS[0].name,
    start_month: start,
    end_month: end,
    rows,
    trend: {
      income_total_sum: rows.reduce((sum, row) => sum + row.income_total, 0),
      expense_total_sum: rows.reduce((sum, row) => sum + row.expense_total, 0),
      amazon_pay_back_sum: rows.reduce((sum, row) => sum + row.amazon_pay_back, 0),
      net_amount_sum: rows.reduce((sum, row) => sum + row.income_total + row.expense_total, 0),
      points: rows.map((row) => ({
        report_month: row.report_month,
        income_total: row.income_total,
        expense_total: row.expense_total,
        amazon_pay_back: row.amazon_pay_back,
        net_amount: row.income_total + row.expense_total,
        has_source_report: true,
      })),
    },
  }
}

function accountingPayload(url: URL) {
  const reportMonth = url.searchParams.get('report_month') ?? '2026-09'
  return {
    project_id: Number(url.searchParams.get('project_id') ?? PROJECTS[0].id),
    project_name: PROJECTS[1].name,
    report_month: reportMonth,
    rows: [
      {
        income_en: 'Product sales',
        income_zh: '销售额',
        income_amount_usd: 1000,
        income_source: '业务报告',
        expense_en: 'Selling fee',
        expense_zh: '销售佣金',
        expense_amount_usd: 100,
        expense_source: '付款报告',
        currency_code: 'EUR',
        kind: 'detail',
      },
      {
        income_en: '',
        income_zh: '',
        income_amount_usd: 0,
        income_source: '',
        expense_en: '',
        expense_zh: '',
        expense_amount_usd: 0,
        expense_source: '',
        kind: 'spacer',
      },
      {
        income_en: 'Total',
        income_zh: '合计',
        income_amount_usd: 1000,
        income_source: '',
        expense_en: 'Total',
        expense_zh: '合计',
        expense_amount_usd: 100,
        expense_source: '',
        currency_code: 'EUR',
        kind: 'total',
      },
    ],
  }
}

async function installApiMocks(page: Page): Promise<ApiAudit> {
  const audit: ApiAudit = { requests: [], unhandled: [] }
  let recognitionSequence = 0

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    audit.requests.push({
      method,
      pathname,
      url: request.url(),
      body: requestBody(request),
    })

    if (pathname === '/api/auth/session') {
      await route.fulfill({ json: SESSION })
      return
    }
    if (pathname === '/api/auth/csrf') {
      await route.fulfill({ json: { csrfToken: 'c3-fixture-csrf' } })
      return
    }
    if (pathname.startsWith('/api/auth/')) {
      await route.fulfill({ json: {} })
      return
    }
    if (pathname === '/api/backend-base') {
      await route.fulfill({ json: { base_url: '' } })
      return
    }
    if (pathname === '/api/exchange-rates') {
      await route.fulfill({
        json: {
          data: [
            { year_month: '2026-08', rate: 7.1 },
            { year_month: '2026-09', rate: 7.2 },
          ],
          pagination: { totalPages: 1 },
        },
      })
      return
    }

    if (!pathname.startsWith('/api/backend/')) {
      audit.unhandled.push(`${method} ${pathname}`)
      await route.fulfill({ status: 404, json: { detail: 'not mocked in C3 matrix' } })
      return
    }

    if (pathname.endsWith('/notifications/unread-count')) {
      await route.fulfill({ json: { count: 0 } })
      return
    }
    if (pathname.endsWith('/notifications')) {
      await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 20 } })
      return
    }
    if (pathname.endsWith('/projects/manage')) {
      await route.fulfill({ json: PROJECTS })
      return
    }
    if (pathname.endsWith('/system-management/operation-audit-logs/client-actions')) {
      await route.fulfill({ status: 204 })
      return
    }

    if (pathname.endsWith('/order-info/filter-options')) {
      await route.fulfill({
        json: {
          projects: PROJECTS.map((project) => ({
            value: String(project.id),
            label: project.name,
          })),
          order_statuses: [
            { value: 'Pending', label: '处理中' },
            { value: 'Shipped', label: '已发货' },
          ],
          fulfillment_channels: [
            { value: 'Amazon', label: 'FBA' },
            { value: 'Merchant', label: 'FBM' },
          ],
          countries: [
            { value: 'US', label: '美国' },
            { value: 'DE', label: '德国' },
          ],
          currencies: [
            { value: 'USD', label: 'USD' },
            { value: 'EUR', label: 'EUR' },
          ],
        },
      })
      return
    }
    if (pathname.endsWith('/order-info/overview')) {
      await route.fulfill({
        json: {
          items: [ORDER_ITEM],
          total: ORDER_STATS.total_orders,
          page: 1,
          page_size: 50,
          stats: ORDER_STATS,
        },
      })
      return
    }
    if (pathname.endsWith('/order-info/list')) {
      await route.fulfill({
        json: {
          items: [PAGED_ORDER_ITEM],
          total: ORDER_STATS.total_orders,
          page: Number(url.searchParams.get('page') ?? 1),
          page_size: 50,
        },
      })
      return
    }
    if (pathname.endsWith('/order-info/export')) {
      await route.fulfill({
        json: {
          filename: 'order-info-c3-fixture.csv',
          content_base64: Buffer.from('order_id\n111-3333333-0000001\n').toString('base64'),
        },
      })
      return
    }
    if (/\/order-info\/\d+$/.test(pathname) && method === 'PATCH') {
      await route.fulfill({
        json: {
          ...ORDER_ITEM,
          carrier: 'UPS',
          tracking_no: '1Z-C3-FIXTURE',
          updated_by: 'E2E',
        },
      })
      return
    }

    if (pathname.endsWith('/product-analysis/calculation/check')) {
      await route.fulfill({ json: PRODUCT_AVAILABILITY })
      return
    }
    if (
      pathname.endsWith('/product-analysis/calculation/run') ||
      pathname.endsWith('/product-analysis/calculation/preview')
    ) {
      await route.fulfill({ json: PRODUCT_RUN_RESULT })
      return
    }
    if (pathname.endsWith('/report-upload/recognize') || pathname.endsWith('/ad-upload/recognize')) {
      await route.fulfill({
        json: recognitionFor(String(request.postData() ?? ''), ++recognitionSequence),
      })
      return
    }
    if (pathname.endsWith('/report-upload/commit') || pathname.endsWith('/ad-upload/commit')) {
      await route.fulfill({ json: { ok: true, ingest_status: 'skipped' } })
      return
    }

    if (pathname.endsWith('/monthly-reports/financial-series/recalculate')) {
      await route.fulfill({
        json: financialPayload(url, url.searchParams.get('country') === 'DE' ? 'EUR' : 'USD'),
      })
      return
    }
    if (pathname.endsWith('/monthly-reports/financial-series/accounting-detail/export')) {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition':
            "attachment; filename*=UTF-8''accounting-detail-c3-fixture.xlsx",
        },
        body: Buffer.from('accounting-detail-c3-fixture'),
      })
      return
    }
    if (pathname.endsWith('/monthly-reports/financial-series/accounting-detail')) {
      await route.fulfill({ json: accountingPayload(url) })
      return
    }
    if (pathname.endsWith('/monthly-reports/financial-series')) {
      await route.fulfill({
        json: financialPayload(url, url.searchParams.get('country') === 'DE' ? 'EUR' : 'USD'),
      })
      return
    }

    audit.unhandled.push(`${method} ${pathname}`)
    await route.fulfill({ status: 404, json: { detail: 'not mocked in C3 matrix' } })
  })

  return audit
}

async function openC3Route(page: Page, context: Parameters<typeof addBLF611FixtureAuth>[0], url: string) {
  await page.setViewportSize(VIEWPORT)
  await addBLF611FixtureAuth(context)
  const response = await page.goto(url)
  await expect(page.locator('.warm-ledger__app-window')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.warm-ledger__topbar--route')).toBeVisible({ timeout: 30_000 })
  expect(response?.ok()).toBe(true)
}

async function expectDesktopWindowGeometry(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const windowElement = document.querySelector<HTMLElement>('.warm-ledger__app-window')
        if (!windowElement) return null
        const rect = windowElement.getBoundingClientRect()
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          left: rect.left,
          top: rect.top,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
          width: rect.width,
          height: rect.height,
          borderRadius: getComputedStyle(windowElement).borderRadius,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
        }
      })
    )
    .toMatchObject({
      viewportWidth: VIEWPORT.width,
      viewportHeight: VIEWPORT.height,
      left: STAGE_INSET,
      top: STAGE_INSET,
      right: STAGE_INSET,
      bottom: STAGE_INSET,
      width: VIEWPORT.width - STAGE_INSET * 2,
      height: VIEWPORT.height - STAGE_INSET * 2,
    })

  const geometry = await page.evaluate(() => {
    const windowElement = document.querySelector<HTMLElement>('.warm-ledger__app-window')!
    return {
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      borderRadius: getComputedStyle(windowElement).borderRadius,
    }
  })
  expect(geometry.documentWidth).toBeLessThanOrEqual(VIEWPORT.width)
  expect(geometry.bodyWidth).toBeLessThanOrEqual(VIEWPORT.width)
  expect(geometry.borderRadius).toBe('22px')
}

async function expectContainedVisibleTables(page: Page) {
  const tables = await page.locator('table:visible').evaluateAll((elements) =>
    elements.map((table) => {
      let ancestor = table.parentElement
      while (ancestor && ancestor !== document.body) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') {
          return {
            ariaLabel: table.getAttribute('aria-label'),
            scrollContainer: ancestor.getAttribute('aria-label') ?? ancestor.className,
            overflowX,
          }
        }
        ancestor = ancestor.parentElement
      }
      return {
        ariaLabel: table.getAttribute('aria-label'),
        scrollContainer: null,
        overflowX: null,
      }
    })
  )

  expect(tables.length).toBeGreaterThan(0)
  for (const table of tables) {
    expect(table.scrollContainer, `table ${table.ariaLabel ?? '(unlabeled)'} should scroll inside its container`).not.toBeNull()
    expect(['auto', 'scroll']).toContain(table.overflowX)
  }
}

function requestsFor(audit: ApiAudit, suffix: string, method?: string) {
  return audit.requests.filter(
    (request) =>
      request.pathname.endsWith(suffix) && (!method || request.method === method)
  )
}

async function selectWarmOption(page: Page, controlName: string, optionName: string) {
  const trigger = page.getByRole('combobox', { name: controlName }).first()
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

async function uploadProductFiles(page: Page, inputId: string) {
  await page.locator(`#${inputId}`).setInputFiles([
    {
      name: 'business.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('business'),
    },
    {
      name: 'payment.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('payment'),
    },
    {
      name: 'ad.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('ad'),
    },
  ])
  await expect(page.getByText(/business\.csv/).first()).toBeVisible()
  await expect(page.getByText(/payment\.csv/).first()).toBeVisible()
  await expect(page.getByText(/ad\.xlsx/).first()).toBeVisible()
}

test.skip(({ isMobile }) => isMobile, 'C3 acceptance is desktop-only')

test.describe('Warm Ledger C3 desktop acceptance', () => {
  test.describe.configure({ timeout: 90_000 })

  test('Order Info keeps exact scope, filters, pagination, CSV, and FBM edit behind mocks', async ({
    page,
    context,
  }) => {
    const audit = await installApiMocks(page)
    await openC3Route(
      page,
      context,
      `${ROUTES.orderInfo}?project_id=1&date_from=2026-10-01&date_to=2026-10-31`
    )
    expect(new URL(page.url()).pathname).toBe(ROUTES.orderInfo)

    await expect(page.getByRole('table', { name: '订单列表' })).toBeVisible()
    await expectDesktopWindowGeometry(page)

    await selectWarmOption(page, '项目筛选', 'C3 Second Store')
    await expect
      .poll(() => requestsFor(audit, '/order-info/overview').at(-1)?.url ?? '')
      .toContain('project_ids=2')

    await selectWarmOption(page, '站点筛选', '德国站 (DE)')
    await expect
      .poll(() => requestsFor(audit, '/order-info/overview').at(-1)?.url ?? '')
      .toContain('countries=DE')

    await page.locator('.warm-ledger__route-date-range').click()
    await page.getByRole('button', { name: '昨天', exact: true }).click()
    await expect
      .poll(() => {
        const latest = new URL(requestsFor(audit, '/order-info/overview').at(-1)?.url ?? 'http://x')
        return latest.searchParams.get('date_from') === latest.searchParams.get('date_to')
      })
      .toBe(true)

    const orderFilters = page.getByRole('group', { name: '订单筛选' })
    const multiSelects = orderFilters.getByRole('combobox')
    await multiSelects.nth(0).click()
    await page.getByRole('option', { name: 'FBA', exact: true }).click()
    await page.keyboard.press('Escape')
    await multiSelects.nth(1).click()
    await page.getByRole('option', { name: '处理中', exact: true }).click()
    await page.keyboard.press('Escape')
    await multiSelects.nth(2).click()
    await page.getByRole('option', { name: 'EUR', exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: '按订单号搜索' }).fill(ORDER_ITEM.amazon_order_id)

    await expect
      .poll(() => {
        const latest = new URL(requestsFor(audit, '/order-info/overview').at(-1)?.url ?? 'http://x')
        return {
          channel: latest.searchParams.get('fulfillment_channels'),
          status: latest.searchParams.get('order_statuses'),
          currency: latest.searchParams.get('currencies'),
          orderId: latest.searchParams.get('order_id_keyword'),
        }
      })
      .toEqual({
        channel: 'Amazon',
        status: 'Pending',
        currency: 'EUR',
        orderId: ORDER_ITEM.amazon_order_id,
      })

    await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled()
    await page.getByRole('button', { name: '下一页' }).click()
    await expect
      .poll(() => requestsFor(audit, '/order-info/list').at(-1)?.url ?? '')
      .toContain('page=2')

    const [orderDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出 CSV' }).click(),
    ])
    expect(orderDownload.suggestedFilename()).toBe('order-info-c3-fixture.csv')
    const exportRequest = requestsFor(audit, '/order-info/export', 'POST').at(-1)
    expect(exportRequest?.body).toMatchObject({
      project_ids: [2],
      fulfillment_channels: ['Amazon'],
      order_statuses: ['Pending'],
      countries: ['DE'],
      currencies: ['EUR'],
      order_id_keyword: ORDER_ITEM.amazon_order_id,
    })
    expect(exportRequest?.body).not.toHaveProperty('page')
    expect(exportRequest?.body).not.toHaveProperty('page_size')
    expect(exportRequest?.body).not.toHaveProperty('sort_by')

    await page
      .getByRole('button', {
        name: `编辑订单 ${PAGED_ORDER_ITEM.amazon_order_id} 的物流信息`,
      })
      .click()
    const dialog = page.getByRole('dialog', { name: /编辑 FBM 订单/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: '物流商（Carrier）' }).fill('UPS')
    await dialog.getByRole('textbox', { name: '物流单号（Tracking No.）' }).fill('1Z-C3-FIXTURE')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(requestsFor(audit, `/order-info/${PAGED_ORDER_ITEM.id}`, 'PATCH')).toHaveLength(1)

    await expectContainedVisibleTables(page)
    await expectDesktopWindowGeometry(page)
    expect(audit.unhandled).toEqual([])
  })

  test('Product Analysis exercises every tab, mocked upload/run/export flow, and contained tables', async ({
    page,
    context,
  }) => {
    const audit = await installApiMocks(page)
    await openC3Route(page, context, ROUTES.productAnalysis)
    expect(new URL(page.url()).pathname).toBe(ROUTES.productAnalysis)
    await expect(page.getByRole('tab', { name: '产品分析核算' })).toBeVisible()
    await expectDesktopWindowGeometry(page)

    await expect(page.getByRole('combobox', { name: '项目' })).toBeEnabled()
    await page.getByRole('button', { name: '检查数据' }).click()
    await expect(page.getByRole('button', { name: '执行核算' })).toBeEnabled()
    await page.getByRole('button', { name: '执行核算' }).click()
    await expect(page.getByRole('button', { name: '展开明细' })).toBeVisible()
    await page.getByRole('button', { name: '展开明细' }).click()
    await expect(page.locator('table:visible')).toBeVisible()
    await expectContainedVisibleTables(page)
    const [productDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出 Excel' }).click(),
    ])
    expect(productDownload.suggestedFilename()).toMatch(/^产品分析核算-.*\.xlsx$/)

    await page.getByRole('tab', { name: '手动核算' }).click()
    await selectWarmOption(page, '项目', 'C3 Fixture Store')
    await uploadProductFiles(page, 'manual-calculation-upload')
    for (const confirmButton of await page.getByRole('button', { name: '确认保存' }).all()) {
      await confirmButton.click()
    }
    await expect(page.getByText('已提交', { exact: true })).toHaveCount(3)
    await page.getByRole('button', { name: '检查数据' }).click()
    await expect(page.getByRole('button', { name: '执行核算' })).toBeEnabled()
    await page.getByRole('button', { name: '执行核算' }).click()
    await expect(page.getByRole('button', { name: '展开明细' })).toBeVisible()
    await page.getByRole('button', { name: '展开明细' }).click()
    await expect(page.locator('table:visible')).toBeVisible()
    await expectContainedVisibleTables(page)
    const [manualDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出 Excel' }).click(),
    ])
    expect(manualDownload.suggestedFilename()).toMatch(/产品核算.*\.xlsx$/)

    await page.getByRole('tab', { name: '月度 SKU 分析' }).click()
    await selectWarmOption(page, '项目', 'C3 Fixture Store')
    await uploadProductFiles(page, 'monthly-sku-upload')
    await page.getByRole('button', { name: '一键识别并提交（不入库）' }).click()
    await expect(page.getByText('已识别（不入库）', { exact: true })).toHaveCount(3)
    await expect(page.getByRole('button', { name: '核算并导出 Excel' })).toBeEnabled()
    const [monthlySkuDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '核算并导出 Excel' }).click(),
    ])
    expect(monthlySkuDownload.suggestedFilename()).toMatch(/^月度SKU分析-.*\.xlsx$/)

    expect(requestsFor(audit, '/product-analysis/calculation/check', 'POST').length).toBeGreaterThan(0)
    expect(requestsFor(audit, '/product-analysis/calculation/run', 'POST').length).toBeGreaterThan(0)
    expect(requestsFor(audit, '/product-analysis/calculation/preview', 'POST')).toHaveLength(1)
    expect(requestsFor(audit, '/report-upload/recognize', 'POST')).toHaveLength(4)
    expect(requestsFor(audit, '/ad-upload/recognize', 'POST')).toHaveLength(2)
    expect(requestsFor(audit, '/report-upload/commit', 'POST')).toHaveLength(4)
    expect(requestsFor(audit, '/ad-upload/commit', 'POST')).toHaveLength(2)

    await expectDesktopWindowGeometry(page)
    expect(audit.unhandled).toEqual([])
  })

  test('Monthly Display updates URL scope, both tabs, both exports, and recalculation under mocks', async ({
    page,
    context,
  }) => {
    const audit = await installApiMocks(page)
    await openC3Route(
      page,
      context,
      `${ROUTES.monthlyDisplay}?project=1&country=US&fromMonth=2025-11&toMonth=2026-10`
    )
    expect(new URL(page.url()).pathname).toBe(ROUTES.monthlyDisplay)
    await expect(page.getByRole('table', { name: '月度财务汇总表' })).toBeVisible()
    await expectDesktopWindowGeometry(page)

    await selectWarmOption(page, '店铺', 'C3 Second Store')
    await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe('2')
    await selectWarmOption(page, '国家', '德国站 (DE)')
    await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBe('DE')

    const startMonthGroup = page.getByRole('group', { name: '开始月份' })
    await startMonthGroup.getByRole('button').click()
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: '10月', exact: true })
      .click()
    await expect.poll(() => new URL(page.url()).searchParams.get('fromMonth')).toBe('2025-10')

    const endMonthGroup = page.getByRole('group', { name: '结束月份' })
    await endMonthGroup.getByRole('button').click()
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: '09月', exact: true })
      .click()
    await expect.poll(() => new URL(page.url()).searchParams.get('toMonth')).toBe('2026-09')

    await expect
      .poll(() => {
        const latest = new URL(requestsFor(audit, '/monthly-reports/financial-series').at(-1)?.url ?? 'http://x')
        return {
          project: latest.searchParams.get('project_id'),
          country: latest.searchParams.get('country'),
          start: latest.searchParams.get('start_month'),
          end: latest.searchParams.get('end_month'),
        }
      })
      .toEqual({
        project: '2',
        country: 'DE',
        start: '2025-10',
        end: '2026-09',
      })

    const [financialDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出财务分析' }).click(),
    ])
    expect(financialDownload.suggestedFilename()).toMatch(/月度财务汇总分析.*\.xlsx$/)

    await page.getByRole('button', { name: '重新核算' }).click()
    await expect
      .poll(() => requestsFor(audit, '/monthly-reports/financial-series/recalculate', 'POST').length)
      .toBe(1)
    await expect(page.getByRole('button', { name: '重新核算' })).toBeEnabled()

    await page.getByRole('tab', { name: '月度明细' }).click()
    await expect(page.getByRole('table', { name: '月度明细表' })).toBeVisible()
    await expect
      .poll(() => requestsFor(audit, '/monthly-reports/financial-series/accounting-detail').length)
      .toBeGreaterThan(0)
    const [accountingDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出核算明细' }).click(),
    ])
    expect(accountingDownload.suggestedFilename()).toBe('accounting-detail-c3-fixture.xlsx')
    expect(
      requestsFor(audit, '/monthly-reports/financial-series/accounting-detail/export').length
    ).toBe(1)
    await page.getByRole('tab', { name: '月度汇总' }).click()
    await expect(page.getByRole('table', { name: '月度财务汇总表' })).toBeVisible()

    await expectContainedVisibleTables(page)
    await expectDesktopWindowGeometry(page)
    expect(audit.unhandled).toEqual([])
  })
})
