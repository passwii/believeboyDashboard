import { expect, test, type Page } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const PROJECT_ID = 1
const PROJECT_NAME = 'C2 E2E Fulfillment Project with a Long Name'
const LONG_SKU = 'C2-SKU-000000000000000000000000000001'
const LONG_SHIPMENT_NO = 'FBA-C2-000000000000000000000000000001'
const LONG_PRODUCT_NAME =
  'C2 fixture product name used to exercise narrow responsive layouts without viewport overflow'

const VIEWPORTS = [1440, 1024, 820, 767, 390, 320] as const

const ROUTES = [
  {
    name: '库存分类账',
    title: '库存分类账',
    pathname: '/dashboard/operations/inventory-ledger',
    url: '/dashboard/operations/inventory-ledger?project_id=1&month=2026-07',
    readyText: '导出库存分析 Excel',
  },
  {
    name: '发货规划',
    title: '发货规划',
    pathname: '/dashboard/operations/shipping-plan',
    url: '/dashboard/operations/shipping-plan?gProject=1&gCountry=US',
    readyTestId: 'shipping-plan-forecast-chart',
  },
  {
    name: '货件管理',
    title: '货件管理',
    pathname: '/dashboard/operations/shipment-management',
    url: '/dashboard/operations/shipment-management',
    readyText: LONG_SHIPMENT_NO,
  },
  {
    name: 'SKU 信息中心',
    title: 'SKU 信息中心',
    pathname: '/dashboard/operations/sku-info',
    url: `/dashboard/operations/sku-info?project_name=${encodeURIComponent(PROJECT_NAME)}`,
    readyText: LONG_SKU,
  },
] as const

const SESSION = {
  user: {
    id: String(PROJECT_ID),
    name: 'E2E',
    fullName: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    isAdmin: true,
  },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [{ id: PROJECT_ID, name: PROJECT_NAME }]

const LEDGER_SUMMARY_ROW = {
  id: 1,
  date: '2026-07-31',
  fnsku: 'X00C2FNSKU01',
  asin: 'B0C2FIXTURE1',
  msku: LONG_SKU,
  title: LONG_PRODUCT_NAME,
  disposition: 'SELLABLE',
  location: 'PHX7',
  starting_balance: 100,
  in_transit_between: 5,
  receipts: 10,
  customer_shipments: 3,
  customer_returns: 1,
  vendor_returns: 0,
  warehouse_transfer_io: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other_events: 0,
  unknown_events: 0,
  ending_balance: 113,
  store: null,
  batch_id: 1,
}

const LEDGER_DETAIL_ROW = {
  id: 1,
  date: '2026-07-31',
  fnsku: 'X00C2FNSKU01',
  asin: 'B0C2FIXTURE1',
  msku: LONG_SKU,
  title: LONG_PRODUCT_NAME,
  event_type: 'Receipts',
  reference_id: 'C2-RECEIPT-0001',
  quantity: 10,
  fulfillment_center: 'PHX7',
  disposition: 'SELLABLE',
  reason: null,
  country: 'US',
  reconciled_quantity: 10,
  unreconciled_quantity: 0,
  date_and_time: '2026-07-31T08:00:00Z',
  store: null,
  batch_id: 1,
}

const LEDGER_MONTH_ANALYSIS = {
  project_id: PROJECT_ID,
  project_name: PROJECT_NAME,
  country: 'US',
  report_month: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  generated_at: '2026-08-01T00:00:00Z',
  summary_rows: [LEDGER_SUMMARY_ROW],
  detail_rows: [LEDGER_DETAIL_ROW],
  snapshot: {
    report_month: '2026-07',
    sku_count: 1,
    total_qty: 113,
    disposition_summary: [{ disposition: 'SELLABLE', qty_eom: 113, pct_of_total: 100 }],
    skus: [{
      msku: LONG_SKU,
      title: LONG_PRODUCT_NAME,
      qty_eom: 113,
      sellable_qty: 113,
      damaged_qty: 0,
      prev_qty_eom: 100,
      change: 13,
    }],
    integrity: {
      report_month: '2026-07',
      status: 'OK',
      mismatch_count: 0,
      mismatches: [],
      comparisons: [],
      checked_at: '2026-08-01T00:00:00Z',
    },
  },
  trend: {
    project_id: PROJECT_ID,
    months: [{
      report_month: '2026-07',
      sku_count: 1,
      total_qty_eom: 113,
      total_receipts: 10,
      total_shipments: 3,
      total_returns: 1,
      total_damaged: 0,
      total_lost: 0,
      total_disposed: 0,
      damaged_pct: 0,
    }],
  },
  consistency: {
    report_month: '2026-07',
    status: 'OK',
    mismatch_count: 0,
    mismatches: [],
    checked_at: '2026-08-01T00:00:00Z',
  },
  batches: [{
    id: 1,
    project_id: PROJECT_ID,
    report_month: '2026-07',
    source_filename: 'C2-inventory-ledger.csv',
    file_hash: 'c2-fixture-hash',
    file_size_bytes: 1024,
    file_kind: 'summary',
    loaded_by: 'E2E',
    loaded_at: '2026-08-01T00:00:00Z',
    completed_at: '2026-08-01T00:00:01Z',
    status: 'success',
    rows_parsed: 1,
    rows_written_summary: 1,
    rows_written_detail: 1,
    rows_skipped_duplicate: 0,
    rows_failed_validation: 0,
    error_message: null,
    consistency_check: 'ok',
    consistency_mismatch_count: 0,
  }],
}

const SHIPPING_PLAN_SKU = {
  sku: LONG_SKU,
  asin: 'B0C2FIXTURE1',
  product_name: LONG_PRODUCT_NAME,
  available_inventory: 30,
  inventory_snapshot_date: '2026-11-02',
  base_dms: '1.25',
  growth_factor: '1.0',
  demand_source: 'manual',
  in_transit_quantity: 10,
  draft_quantity: 5,
  active_plan_remaining_quantity: 8,
  confirmed_180d_sales_upper_bound: '150',
  planned_180d_sales_upper_bound: '180',
  data_quality: [],
}

const SHIPPING_SKUS = {
  items: [SHIPPING_PLAN_SKU],
  total: 1,
  page: 1,
  page_size: 200,
  valid_forecast_sku_count: 1,
  missing_forecast_sku_count: 0,
  known_confirmed_sales_upper_bound: '150',
  known_planned_sales_upper_bound: '180',
}

const SHIPPING_BATCHES = {
  items: [{
    id: 1,
    project_id: PROJECT_ID,
    country: 'US',
    name: 'C2-PLAN-2026-11',
    expected_arrival_date: '2026-11-20',
    status: 'active',
    remark: null,
    items: [{
      id: 11,
      sku: LONG_SKU,
      quantity: 12,
      allocated_quantity: 4,
      remaining_quantity: 8,
      allocations: [{
        id: 21,
        plan_item_id: 11,
        shipment_schedule_id: 90,
        sku: LONG_SKU,
        quantity: 4,
      }],
    }],
  }],
  total: 1,
}

const SHIPPING_HISTORY = {
  project_id: PROJECT_ID,
  country: 'US',
  etd_from: '2025-11-03',
  etd_to: '2026-11-03',
  months: [{ month: '2026-10', shipment_count: 2, quantity: 40 }],
  sales_months: [{ month: '2026-10', sales_quantity: 35, covered: true }],
  missing_etd_shipment_count: 1,
  missing_etd_quantity: 7,
  included_statuses: ['in_transit', 'completed'],
  date_basis: 'ETD 作为 V1 计划发运日期代理，不代表实际离港日',
  sales_basis: 'E2E fixture',
}

function shippingForecast(url: URL, growthFactor = 1) {
  const asOfDate = url.searchParams.get('as_of_date') ?? '2026-11-03'
  return {
    project_id: PROJECT_ID,
    country: 'US',
    sku: LONG_SKU,
    as_of_date: asOfDate,
    forecast_start_date: '2026-11-04',
    forecast_end_date: '2027-05-02',
    inventory_snapshot_date: '2026-11-02',
    sales_baseline_start_date: '2026-10-04',
    sales_baseline_end_date: asOfDate,
    base_dms: '1.25',
    growth_factor: String(growthFactor),
    demand_source: 'manual',
    data_quality: [],
    daily_points: [{
      forecast_date: '2026-11-04',
      demand: 1.25 * growthFactor,
      confirmed_sales: 1.25 * growthFactor,
      planned_sales: 1.25 * growthFactor,
      confirmed_closing_inventory: 38.75,
      planned_closing_inventory: 38.75,
      historical_order_sales: null,
    }],
    confirmed_180d_sales_upper_bound: '150',
    planned_180d_sales_upper_bound: '180',
    unverified_completed_quantity: 0,
    overdue_shipment_quantity: 0,
    overdue_plan_quantity: 0,
    arrivals: [],
  }
}

const SHIPMENT_LIST = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  project_id: PROJECT_ID,
  project_name: PROJECT_NAME,
  country: 'US',
  shipment_no: index === 0 ? LONG_SHIPMENT_NO : `FBA-C2-${String(index + 1).padStart(6, '0')}`,
  tracking_no: `C2-TRACK-${String(index + 1).padStart(6, '0')}`,
  warehouse_code: 'PHX7',
  forwarder_name: 'C2 Fixture Freight Forwarder',
  shipping_method: 'sea',
  created_date: '2026-07-01',
  etd_date: '2026-07-10',
  eta_date: '2026-08-10',
  actual_inbound_date: null,
  shipment_status: 'in_transit',
  remark: null,
  sku_count: 1,
  total_quantity: 100 + index,
  logistics_unit_price: 8.5,
  total_volume_m3: 3.2,
  total_chargeable_weight_kg: 40,
  logistics_total_price: 340,
  include_in_history_shipping_calc: true,
  updated_at: '2026-07-02T00:00:00Z',
  shipment_batch: 'C2-2026-07',
}))

const SHIPMENT_LIST_RESPONSE = {
  items: SHIPMENT_LIST,
  page: 1,
  page_size: 20,
  total: SHIPMENT_LIST.length,
  has_next: false,
}

const SHIPMENT_DETAIL = {
  ...SHIPMENT_LIST[0],
  items: [{
    id: 11,
    item_date: null,
    sku: LONG_SKU,
    quantity: 100,
    carton_count: 10,
    remark: null,
    volume_m3: 3.2,
    actual_weight_kg: 40,
    volumetric_weight_kg: 32,
    chargeable_weight_kg: 40,
    estimated_logistics_cost: 340,
    average_logistics_unit_price: 8.5,
  }],
}

const SHIPMENT_SKU_SUMMARY = {
  items: [{
    project_id: PROJECT_ID,
    project_name: PROJECT_NAME,
    country: 'US',
    sku: LONG_SKU,
    shipment_count: 2,
    total_quantity: 200,
    total_chargeable_weight_kg: 80,
    total_logistics_cost: 680,
    average_logistics_unit_price: 8.5,
  }],
}

const IMAGE_FIXTURE_DATA_URL =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22 viewBox=%220 0 80 80%22%3E%3Crect width=%2280%22 height=%2280%22 fill=%22%23d6a64f%22/%3E%3C/svg%3E'

const FBA_BOX_ITEM = {
  project_id: PROJECT_ID,
  project_name: PROJECT_NAME,
  country: 'US',
  shipment_no: LONG_SHIPMENT_NO,
  warehouse_code: 'PHX7',
  sku: LONG_SKU,
  product_name: LONG_PRODUCT_NAME,
  asin: 'B0C2FIXTURE1',
  fnsku: 'X00C2FNSKU01',
  package_length_cm: 10,
  package_width_cm: 8,
  package_height_cm: 6,
  weight_kg: 0.2,
  length_cm: 50,
  width_cm: 40,
  height_cm: 30,
  carton_weight_kg: 12,
  quantity: 100,
  units_per_carton: 10,
  carton_count: 10,
  full_carton_count: 10,
  partial_carton_units: 0,
  outer_box_text: '50 × 40 × 30 cm',
  total_weight_kg: 120,
  total_volume_m3: 0.6,
  fba_label_prefix: 'X00',
  tracking_no: 'C2-TRACK-000001',
  product_image_thumbnail_r2_url: IMAGE_FIXTURE_DATA_URL,
  product_image_r2_url: IMAGE_FIXTURE_DATA_URL,
}

const SKU_INFO_ITEM = {
  id: 101,
  project_name: PROJECT_NAME,
  sku: LONG_SKU,
  asin: 'B0C2FIXTURE1',
  fnsku: 'X00C2FNSKU01',
  product_name: LONG_PRODUCT_NAME,
  father_id: null,
  fob_unit_cost: 5.5,
  first_leg_cost_rmb: 12.3,
  historical_first_leg_cost_rmb: 12.3,
  package_length_cm: 10,
  package_width_cm: 8,
  package_height_cm: 6,
  weight_kg: 0.2,
  carton_length_cm: 50,
  carton_width_cm: 40,
  carton_height_cm: 30,
  carton_weight_kg: 12,
  units_per_carton: 100,
  currency: 'USD',
  country: 'US',
  sort_order: 1,
  is_active: true,
  sku_factory_info: null,
  sku_factory_info_updated_at: null,
  sku_factory_info_updated_by: null,
  listing_title: null,
  listing_bullet_1: null,
  listing_bullet_2: null,
  listing_bullet_3: null,
  listing_bullet_4: null,
  listing_bullet_5: null,
  listing_description: null,
  listing_selling_points: null,
  listing_copy_updated_at: null,
  listing_copy_updated_by: null,
  fnsku_label_r2_key: null,
  fnsku_label_r2_url: null,
  product_image_r2_key: null,
  product_image_r2_url: null,
  product_image_thumbnail_r2_key: null,
  product_image_thumbnail_r2_url: null,
}

const SKU_INFO_RESPONSE = {
  items: [SKU_INFO_ITEM],
  page: 1,
  page_size: 10000,
  total: 1,
  has_next: false,
}

const NOTIFICATIONS = { items: [], total: 0, page: 1, page_size: 20 }

interface MockRequestAudit {
  method: string
  pathname: string
  url: string
  body: unknown
}

interface MockAudit {
  unhandled: string[]
  writes: string[]
  requests: MockRequestAudit[]
  inventoryMonthsStatuses: number[]
  allowInventoryMonthsRetry: () => void
}

interface MockOptions {
  failInventoryMonthsUntilRetry?: boolean
}

async function installPageRoutes(page: Page, options: MockOptions = {}): Promise<MockAudit> {
  let inventoryMonthsRetryEnabled = !options.failInventoryMonthsUntilRetry
  let currentGrowthFactor = 1
  let currentSkuInfoItem = SKU_INFO_ITEM
  const audit: MockAudit = {
    unhandled: [],
    writes: [],
    requests: [],
    inventoryMonthsStatuses: [],
    allowInventoryMonthsRetry: () => { inventoryMonthsRetryEnabled = true },
  }

  await page.route('**/api/auth/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/session')) {
      await route.fulfill({ json: SESSION })
      return
    }
    if (pathname.endsWith('/csrf')) {
      await route.fulfill({ json: { csrfToken: 'c2-e2e-csrf-token' } })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'not mocked in C2 matrix' } })
  })

  await page.route('**/api/backend-base**', async (route) => {
    await route.fulfill({ json: { base_url: '' } })
  })

  // Catch all proxied backend traffic so this spec cannot reach a real API.
  await page.route('**/api/backend/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    let body: unknown = null
    if (request.postData()) {
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
    }
    audit.requests.push({ method, pathname, url: request.url(), body })
    if (method !== 'GET' && method !== 'HEAD') audit.writes.push(`${method} ${pathname}`)

    if (pathname.endsWith('/notifications/unread-count')) {
      await route.fulfill({ json: { count: 0 } })
      return
    }
    if (pathname.endsWith('/notifications')) {
      await route.fulfill({ json: NOTIFICATIONS })
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
    if (pathname.endsWith('/inventory-ledger/months')) {
      if (!inventoryMonthsRetryEnabled) {
        audit.inventoryMonthsStatuses.push(503)
        await route.fulfill({ status: 503, json: { detail: 'C2 fixture transient month-options failure' } })
        return
      }
      audit.inventoryMonthsStatuses.push(200)
      await route.fulfill({ json: { months: ['2026-07', '2026-06'] } })
      return
    }
    if (pathname.endsWith('/inventory-ledger/month-analysis')) {
      await route.fulfill({ json: LEDGER_MONTH_ANALYSIS })
      return
    }
    if (/\/shipping-plan\/skus\/[^/]+\/growth-factor$/.test(pathname) && method === 'PUT') {
      const growthFactorBody = body as { project_id: number; country: string; growth_factor: number }
      currentGrowthFactor = growthFactorBody.growth_factor
      await route.fulfill({ json: {
        project_id: growthFactorBody.project_id,
        country: growthFactorBody.country,
        sku: LONG_SKU,
        growth_factor: String(currentGrowthFactor),
        demand_source: 'manual',
      } })
      return
    }
    if (pathname.endsWith('/shipping-plan/skus')) {
      await route.fulfill({ json: {
        ...SHIPPING_SKUS,
        items: SHIPPING_SKUS.items.map((item) => ({ ...item, growth_factor: String(currentGrowthFactor) })),
      } })
      return
    }
    if (pathname.endsWith('/shipping-plan/forecast')) {
      await route.fulfill({ json: shippingForecast(url, currentGrowthFactor) })
      return
    }
    if (pathname.endsWith('/shipping-plan/shipment-history')) {
      await route.fulfill({ json: SHIPPING_HISTORY })
      return
    }
    if (pathname.endsWith('/shipping-plan/batches')) {
      await route.fulfill({ json: SHIPPING_BATCHES })
      return
    }
    if (/\/shipment-schedules\/\d+\/costs\/calculate$/.test(pathname) && method === 'POST') {
      const costBody = body as { logistics_unit_price: number }
      const logisticsUnitPrice = costBody.logistics_unit_price
      const updatedDetail = {
        ...SHIPMENT_DETAIL,
        logistics_unit_price: logisticsUnitPrice,
        logistics_total_price: logisticsUnitPrice * 100,
        items: SHIPMENT_DETAIL.items.map((item) => ({
          ...item,
          average_logistics_unit_price: logisticsUnitPrice,
          estimated_logistics_cost: logisticsUnitPrice * item.quantity,
        })),
      }
      await route.fulfill({ json: updatedDetail })
      return
    }
    if (pathname.endsWith('/shipment-schedules/cost-summary')) {
      await route.fulfill({ json: {
        shipment_count: SHIPMENT_LIST.length,
        total_sku: SHIPMENT_LIST.length,
        total_quantity: 828,
        total_chargeable_weight_kg: 320,
        total_logistics_cost: 2720,
      } })
      return
    }
    if (pathname.endsWith('/shipment-schedules/sku-summary')) {
      await route.fulfill({ json: SHIPMENT_SKU_SUMMARY })
      return
    }
    if (pathname.endsWith('/shipment-schedules/batches')) {
      await route.fulfill({ json: { batches: ['C2-2026-07'] } })
      return
    }
    if (pathname.endsWith('/shipment-schedules/fba-box-details')) {
      await route.fulfill({ json: {
        project_ids: [PROJECT_ID],
        project_names: [PROJECT_NAME],
        countries: ['US'],
        shipment_nos: [LONG_SHIPMENT_NO],
        items: [FBA_BOX_ITEM],
      } })
      return
    }
    if (/\/shipment-schedules\/\d+$/.test(pathname)) {
      await route.fulfill({ json: SHIPMENT_DETAIL })
      return
    }
    if (pathname.endsWith('/shipment-schedules')) {
      await route.fulfill({ json: SHIPMENT_LIST_RESPONSE })
      return
    }
    if (/\/sku-info\/\d+$/.test(pathname) && method === 'PATCH') {
      const patch = body as { sku: string; fob_unit_cost: number; source_file: string }
      currentSkuInfoItem = {
        ...currentSkuInfoItem,
        sku: patch.sku,
        fob_unit_cost: patch.fob_unit_cost,
      }
      await route.fulfill({ json: currentSkuInfoItem })
      return
    }
    if (pathname.endsWith('/sku-info/export')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        body: 'project_name,SKU\nC2 E2E Fulfillment Project,C2-SKU-FIXTURE\n',
      })
      return
    }
    if (pathname.includes('/sku-info')) {
      await route.fulfill({ json: { ...SKU_INFO_RESPONSE, items: [currentSkuInfoItem] } })
      return
    }

    audit.unhandled.push(`${method} ${pathname}`)
    await route.fulfill({ status: 404, json: { detail: 'not mocked in C2 matrix' } })
  })

  return audit
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const root = document.documentElement
    const describe = (element: Element | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      let ancestor = element.parentElement
      let scrollableAncestor: Element | null = null
      while (ancestor && ancestor !== document.body) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') {
          scrollableAncestor = ancestor
          break
        }
        ancestor = ancestor.parentElement
      }
      const selector = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join('')}`
      return {
        selector,
        rect: { left: rect.left, right: rect.right, width: rect.width, top: rect.top, height: rect.height },
        overflowX: style.overflowX,
        position: style.position,
        transform: style.transform,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollableAncestor: scrollableAncestor ? {
          selector: `${scrollableAncestor.tagName.toLowerCase()}${scrollableAncestor.id ? `#${scrollableAncestor.id}` : ''}${Array.from(scrollableAncestor.classList).slice(0, 3).map((name) => `.${name}`).join('')}`,
          overflowX: getComputedStyle(scrollableAncestor).overflowX,
          scrollWidth: scrollableAncestor.scrollWidth,
          clientWidth: scrollableAncestor.clientWidth,
        } : null,
      }
    }
    const visibleElements = Array.from(document.querySelectorAll('body *')).filter((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
    const widestVisible = visibleElements
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0] ?? null
    const widestOutside = visibleElements
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left < -2 || rect.right > root.clientWidth + 2
      })
      .sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0] ?? null
    return {
      viewportWidth: root.clientWidth,
      documentWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      windowScrollX: window.scrollX,
      widestVisible: describe(widestVisible),
      widestOutside: describe(widestOutside),
      sidebar: describe(document.querySelector('#dashboard-sidebar')),
      firstTable: describe(document.querySelector('table')),
    }
  })
  if (dimensions.bodyScrollWidth - dimensions.viewportWidth > 2 || dimensions.documentWidth - dimensions.viewportWidth > 2) {
    console.info(`[C2 matrix DOM overflow diagnostic] ${JSON.stringify(dimensions)}`)
  }
  expect(
    dimensions.documentWidth - dimensions.viewportWidth,
    'page-level horizontal overflow (table-contained scrolling is allowed)'
  ).toBeLessThanOrEqual(2)
}

async function expectTableScrollIsContained(page: Page, viewportWidth: number) {
  const visibleTable = page.locator('table:visible').first()
  if (await visibleTable.count() === 0) return

  const metrics = await visibleTable.evaluate((table) => {
    let ancestor = table.parentElement
    while (ancestor && ancestor !== document.body) {
      const overflowX = getComputedStyle(ancestor).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return {
          overflowX,
          containerClientWidth: ancestor.clientWidth,
          containerScrollWidth: ancestor.scrollWidth,
          tableScrollWidth: table.scrollWidth,
        }
      }
      ancestor = ancestor.parentElement
    }
    return null
  })

  expect(metrics, 'data table should have a scrollable ancestor').not.toBeNull()
  if (viewportWidth <= 390 && metrics) {
    expect(metrics.containerScrollWidth).toBeGreaterThan(metrics.containerClientWidth + 2)
    expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.containerClientWidth + 2)
  }
}

async function expectTouchTarget(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox()
  expect(box, 'core control should have a measurable hit target').not.toBeNull()
  if (!box) return
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
}

async function openRouteFrame(page: Page, route: (typeof ROUTES)[number], width: number) {
  await page.setViewportSize({ width, height: 960 })
  const navigationResponse = await page.goto(route.url)
  const finalPageUrl = page.url()
  const requestedHref = route.url
  const frameAssertionMessage = [
    'Warm route frame was not visible after navigation.',
    `requested href: ${requestedHref}`,
    `page.goto response status: ${navigationResponse?.status() ?? 'no response'}`,
    `final page.url(): ${finalPageUrl}`,
  ].join(' ')

  await expect(page.locator('.warm-ledger__topbar--route'), frameAssertionMessage).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.warm-ledger__breadcrumb [aria-current="page"]')).toHaveText(route.title)
  await expect(page.locator('main#main-content')).toBeVisible()

  const activeRouteLink = page.locator(`#dashboard-sidebar a[href="${route.pathname}"]`)
  await expect(activeRouteLink).toHaveAttribute('aria-current', 'page')
  expect(new URL(page.url()).pathname).toBe(route.pathname)

  if ('readyTestId' in route) {
    await expect(page.getByTestId(route.readyTestId)).toBeVisible({ timeout: 30_000 })
  } else {
    await expect(page.getByText(route.readyText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  }
}

async function openRouteAndCheck(
  page: Page,
  audit: MockAudit,
  route: (typeof ROUTES)[number],
  width: number
) {
  await openRouteFrame(page, route, width)
  const mobileMenu = page.getByRole('button', { name: '打开导航' })
  if (width <= 820) {
    await expect(mobileMenu).toBeVisible()
    await expectTouchTarget(mobileMenu)
  } else {
    await expect(mobileMenu).toBeHidden()
  }

  let mobileFilterGrid = page.getByTestId('mobile-filter-strip-grid')
  if (width < 768) {
    const strip = page.getByTestId('mobile-filter-strip')
    await expect(strip).toBeVisible()
    const toggle = strip.getByRole('button', { name: '切换页面筛选' })
    await expect(toggle).toBeVisible()
    await expectTouchTarget(toggle)
    await toggle.click()
    mobileFilterGrid = page.getByTestId('mobile-filter-strip-grid')
    await expect(mobileFilterGrid).toBeVisible()
  } else {
    await expect(page.getByTestId('mobile-filter-strip')).toHaveCount(0)
  }

  if (width <= 820) {
    const filterControl = width < 768
      ? mobileFilterGrid.getByRole('combobox').first()
      : page.locator('.warm-ledger__route-slot-row [role="combobox"]:visible').first()
    await expect(filterControl).toBeVisible()
    await expectTouchTarget(filterControl)
  }

  const layoutResults = await Promise.allSettled([
    expectNoPageOverflow(page),
    expectTableScrollIsContained(page, width),
  ])
  const layoutFailures = layoutResults.flatMap((result) => {
    if (result.status === 'fulfilled') return []
    return [result.reason instanceof Error ? result.reason.message : String(result.reason)]
  })
  expect(layoutFailures, 'page overflow and table-contained scrolling checks').toEqual([])
  expect(audit.unhandled, 'all proxied backend APIs must have a route mock').toEqual([])
  expect(audit.writes, 'viewport and safe UI checks must not send write requests').toEqual([])
}

for (const route of ROUTES) {
  test.describe(`${route.name} · Warm C2 viewport matrix`, () => {
    for (const width of VIEWPORTS) {
      test(`${width}px: exact route frame, responsive filters, contained data`, async ({ page, context }) => {
        const audit = await installPageRoutes(page)
        await addBLF611FixtureAuth(context)
        await openRouteAndCheck(page, audit, route, width)
      })
    }
  })
}

const SAFE_INTERACTIONS = [
  {
    route: ROUTES[0],
    title: '切换库存分类账 tab 不发写请求',
    async run(page: Page) {
      const detailTab = page.getByRole('tab', { name: /明细视图/ })
      await detailTab.click()
      await expect(detailTab).toHaveAttribute('aria-selected', 'true')
    },
  },
  {
    route: ROUTES[1],
    title: '展开发货规划移动筛选条不发写请求',
    async run(page: Page) {
      const strip = page.getByTestId('mobile-filter-strip')
      const toggle = strip.getByRole('button', { name: '切换页面筛选' })
      const grid = page.getByTestId('mobile-filter-strip-grid')
      await toggle.click()
      await expect(grid).toBeVisible()
      await toggle.click()
      await expect(grid).toBeHidden()
    },
  },
  {
    route: ROUTES[2],
    title: '切换货件管理费用 tab 只读取数据',
    async run(page: Page) {
      const costTab = page.getByRole('tab', { name: '发货费用' })
      await costTab.click()
      await expect(costTab).toHaveAttribute('aria-selected', 'true')
    },
  },
  {
    route: ROUTES[3],
    title: '切换 SKU 信息尺寸 tab 不发写请求',
    async run(page: Page) {
      const dimensionTab = page.getByRole('tab', { name: '尺寸管理' })
      await dimensionTab.click()
      await expect(dimensionTab).toHaveAttribute('aria-selected', 'true')
    },
  },
] as const

for (const scenario of SAFE_INTERACTIONS) {
  test(`${scenario.title}`, async ({ page, context }) => {
    const audit = await installPageRoutes(page)
    await addBLF611FixtureAuth(context)
    await openRouteFrame(page, scenario.route, 390)
    await scenario.run(page)
    expect(audit.unhandled, 'all proxied backend APIs must have a route mock').toEqual([])
    expect(audit.writes, 'this spec must not send write requests').toEqual([])
  })
}

test('库存分类账 applies a dimension filter and exports the full-month workbook', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteAndCheck(page, audit, ROUTES[0], 390)
  const initialAnalysisRequestCount = audit.requests.filter((request) =>
    request.pathname.endsWith('/inventory-ledger/month-analysis')
  ).length
  expect(initialAnalysisRequestCount).toBeGreaterThan(0)

  const filterGrid = page.getByTestId('mobile-filter-strip-grid')
  const skuFilter = filterGrid.getByRole('combobox', { name: 'SKU 筛选' })
  await skuFilter.click()
  await page.getByRole('option', { name: LONG_SKU, exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('msku')).toBe(LONG_SKU)
  await expect(filterGrid.getByRole('button', { name: /清除筛选/ })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出库存分析 Excel' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^库存分类账分析-.*-2026-07\.xlsx$/)

  const analysisRequests = audit.requests.filter((request) => request.pathname.endsWith('/inventory-ledger/month-analysis'))
  expect(analysisRequests).toHaveLength(initialAnalysisRequestCount)
  for (const request of analysisRequests) {
    const analysisParams = new URL(request.url).searchParams
    expect(analysisParams.get('project_id')).toBe(String(PROJECT_ID))
    expect(analysisParams.get('period')).toBe('2026-07')
    expect(analysisParams.has('msku')).toBe(false)
  }
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('库存分类账 recovers from a month-options error with its retry action', async ({ page, context }) => {
  const audit = await installPageRoutes(page, { failInventoryMonthsUntilRetry: true })
  await addBLF611FixtureAuth(context)
  await openRouteAndCheck(page, audit, ROUTES[0], 1024)

  const retry = page.getByRole('button', { name: '重试加载月份列表' })
  await expect(retry).toBeVisible()
  audit.allowInventoryMonthsRetry()
  await retry.click()
  await expect(retry).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '月份筛选' })).toBeEnabled()

  expect(audit.inventoryMonthsStatuses.some((status) => status === 503)).toBe(true)
  expect(audit.inventoryMonthsStatuses.at(-1)).toBe(200)
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('发货规划 saves a growth factor and issues exactly one scoped forecast refresh', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[1], 1024)

  const forecastRequests = () => audit.requests.filter((request) => {
    if (request.method !== 'GET' || !request.pathname.endsWith('/shipping-plan/forecast')) return false
    const params = new URL(request.url).searchParams
    return params.get('project_id') === String(PROJECT_ID) &&
      params.get('country') === 'US' &&
      params.get('sku') === LONG_SKU
  })
  const initialForecastCount = forecastRequests().length
  expect(initialForecastCount).toBeGreaterThan(0)

  const growthFactor = page.getByRole('spinbutton', { name: 'SKU 增长系数' })
  await growthFactor.fill('1.25')
  await page.getByRole('button', { name: '保存增长系数' }).click()
  await expect(growthFactor).toHaveValue('1.25')
  await expect(page.getByRole('button', { name: '保存增长系数' })).toBeEnabled()
  await expect.poll(() => forecastRequests().length).toBe(initialForecastCount + 1)
  await page.waitForTimeout(200)
  expect(forecastRequests()).toHaveLength(initialForecastCount + 1)

  const growthFactorPut = audit.requests.filter((request) =>
    request.method === 'PUT' && request.pathname.endsWith(`/shipping-plan/skus/${LONG_SKU}/growth-factor`)
  )
  expect(growthFactorPut).toHaveLength(1)
  expect(growthFactorPut[0]?.body).toEqual({
    project_id: PROJECT_ID,
    country: 'US',
    growth_factor: 1.25,
  })
  expect(audit.writes).toEqual([`PUT /api/backend/api/v1/shipping-plan/skus/${LONG_SKU}/growth-factor`])
  expect(audit.unhandled).toEqual([])
})

test('货件管理 recalculates shipment costs with a mocked writeback', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[2], 1024)

  const shipmentRow = page.getByRole('row').filter({ hasText: LONG_SHIPMENT_NO })
  await shipmentRow.getByRole('button', { name: '编辑' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '编辑船期批次' })).toBeVisible()
  await dialog.getByRole('button', { name: '核算并写回' }).click()

  await expect.poll(() => audit.requests.filter((request) =>
    request.method === 'POST' && /\/shipment-schedules\/\d+\/costs\/calculate$/.test(request.pathname)
  ).length).toBe(1)
  await expect(dialog.getByRole('cell', { name: '¥ 850', exact: true })).toBeVisible()

  const calculationRequest = audit.requests.find((request) =>
    request.method === 'POST' && /\/shipment-schedules\/\d+\/costs\/calculate$/.test(request.pathname)
  )
  expect(calculationRequest?.body).toEqual({ logistics_unit_price: 8.5 })
  expect(audit.writes).toHaveLength(1)
  expect(audit.unhandled).toEqual([])
})

test('货件管理 cost tab exports its scoped workbook and mocks its audit call', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[2], 1024)

  await page.getByRole('tab', { name: '发货费用' }).click()
  await expect(page.getByText('总运费', { exact: true })).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 Excel' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^发货费用-.*\.xlsx$/)
  await expect.poll(() => audit.requests.filter((request) =>
    request.pathname.endsWith('/system-management/operation-audit-logs/client-actions')
  ).length).toBe(1)

  const auditRequest = audit.requests.find((request) =>
    request.pathname.endsWith('/system-management/operation-audit-logs/client-actions')
  )
  expect(auditRequest?.method).toBe('POST')
  expect((auditRequest?.body as { action?: string } | null)?.action).toBe('shipment_schedules.costs.export')
  expect(audit.writes).toEqual(['POST /api/backend/api/v1/system-management/operation-audit-logs/client-actions'])
  expect(audit.unhandled).toEqual([])
})

test('货件管理 dialog closes with Escape and restores focus to its opener', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[2], 1024)

  const opener = page.getByRole('button', { name: '新建批次' })
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新建船期批次' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('SKU 信息 submits project and SKU filters explicitly, then exports the loaded scope', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await page.setViewportSize({ width: 1024, height: 960 })
  await page.goto('/dashboard/operations/sku-info')
  await expect(page.locator('.warm-ledger__topbar--route')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.warm-ledger__breadcrumb [aria-current="page"]')).toHaveText('SKU 信息中心')

  const projectFilter = page.getByRole('combobox', { name: '项目' })
  await expect(projectFilter).toBeEnabled()
  await projectFilter.click()
  await page.getByRole('option', { name: PROJECT_NAME, exact: true }).click()
  await page.getByRole('textbox', { name: 'SKU 或 ASIN 搜索' }).fill(LONG_SKU)
  expect(audit.requests.filter((request) => request.pathname.endsWith('/sku-info') && !request.pathname.endsWith('/sku-info/export'))).toHaveLength(0)

  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByText(LONG_SKU, { exact: true }).first()).toBeVisible()
  const queryRequest = audit.requests.find((request) =>
    request.method === 'GET' && request.pathname.endsWith('/sku-info') && !request.pathname.endsWith('/sku-info/export')
  )
  expect(queryRequest).toBeDefined()
  const queryParams = new URL(queryRequest!.url).searchParams
  expect(queryParams.get('project_name')).toBe(PROJECT_NAME)
  expect(queryParams.get('sku')).toBe(LONG_SKU)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出批量修改' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/SKU信息-成本管理批量修改模板-.*\.csv$/)
  const exportRequest = audit.requests.find((request) => request.pathname.endsWith('/sku-info/export'))
  expect(exportRequest).toBeDefined()
  const exportParams = new URL(exportRequest!.url).searchParams
  expect(exportParams.get('project_name')).toBe(PROJECT_NAME)
  expect(exportParams.get('sku')).toBe(LONG_SKU)
  expect(exportParams.get('export_type')).toBe('cost')
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('库存分类账 batches tab is a read-only upload history view', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteAndCheck(page, audit, ROUTES[0], 1024)

  await page.getByRole('tab', { name: '上传批次' }).click()
  await expect(page.getByText('C2-inventory-ledger.csv')).toBeVisible()
  await expect(page.locator('input[type="file"]')).toHaveCount(0)
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('SKU 信息 FactoryInfoSheet closes with Escape and restores focus to its row opener', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[3], 1024)

  const factoryTab = page.getByRole('tab', { name: '产品属性' })
  await factoryTab.click()
  await expect(factoryTab).toHaveAttribute('aria-selected', 'true')
  const factoryPanel = page.getByRole('tabpanel', { name: '产品属性' })
  await expect(factoryPanel).toBeVisible()
  const opener = factoryPanel.getByRole('button', { name: '编辑' }).first()
  await expect(opener).toBeVisible()
  await opener.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading', { name: `编辑产品属性 - ${LONG_SKU}`, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(opener).toBeFocused()
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('货件管理 FBA image lightbox closes with Escape and restores focus without external images', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  const shipmentWithSelectedNumber = {
    ...ROUTES[2],
    url: `${ROUTES[2].pathname}?shipment_no=${encodeURIComponent(LONG_SHIPMENT_NO)}`,
  }
  await openRouteFrame(page, shipmentWithSelectedNumber, 1024)
  await page.getByRole('tab', { name: 'FBA 箱单明细' }).click()

  const opener = page.getByRole('button', { name: `查看 ${LONG_SKU} 产品大图` })
  await expect(opener).toBeVisible()
  await opener.click()
  const lightbox = page.getByRole('dialog')
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('img')).toHaveAttribute('src', IMAGE_FIXTURE_DATA_URL)
  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()
  await expect(opener).toBeFocused()
  expect(audit.writes).toEqual([])
  expect(audit.unhandled).toEqual([])
})

test('SKU 信息 row editing issues one mocked record-id PATCH', async ({ page, context }) => {
  const audit = await installPageRoutes(page)
  await addBLF611FixtureAuth(context)
  await openRouteFrame(page, ROUTES[3], 1024)

  const row = page.locator('table:visible tbody tr').first()
  await expect(row).toContainText(LONG_SKU)
  await row.getByRole('button', { name: '编辑' }).click()
  const editingRow = page.locator('table:visible tbody tr').first()
  const fobCostInput = editingRow.locator('td').nth(6).getByRole('textbox')
  await fobCostInput.fill('6.25')
  await editingRow.getByRole('button', { name: '保存' }).click()

  await expect.poll(() => audit.requests.filter((request) =>
    request.method === 'PATCH' && request.pathname === '/api/backend/api/v1/sku-info/101'
  ).length).toBe(1)
  await expect(page.locator('table:visible tbody tr').first().locator('td').nth(6)).toContainText('6.25')

  const patch = audit.requests.find((request) =>
    request.method === 'PATCH' && request.pathname === '/api/backend/api/v1/sku-info/101'
  )
  expect(patch?.body).toMatchObject({ sku: LONG_SKU, fob_unit_cost: 6.25, source_file: 'manual_inline_edit' })
  expect(audit.writes).toEqual(['PATCH /api/backend/api/v1/sku-info/101'])
  expect(audit.unhandled).toEqual([])
})
