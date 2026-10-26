import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-613 运营域A手机端适配回归（库存分类账 / 季节性补货 / SKU 信息 / 货件管理）。
 *
 * 自包含：session 与全部后端请求经 page.route mock，不依赖真实后端 / 登录态，
 * 可在无 .env.local 的环境直接跑。默认随 mobile project（Pixel 5，393×851）跑；
 * 桌面零回归用例在测试内切 1440×900 视口。
 *
 * 认证：/dashboard 由 proxy.ts（next-auth v5 auth 中间件）守卫，需要合法 JWE
 * session cookie；这里用 next-auth/jwt 的 encode 以 BLF611_FIXTURE_SECRET 伪造一枚
 *（secret 与 playwright.config webServer.env 一致，复用 BLF-611 fixture 常量）。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：KPI/统计卡手机端一行两个（grid-cols-2），不挤压；
 * - 总则 2：宽组件（表格/卡片列表容器）独占一行；
 * - 规则 2：筛选控制台手机端 2 列网格；
 * - 规则 4：DataTableCardStatBar 手机端 2×2 网格（本任务对共享组件做的响应式改造）；
 * - 规则 5：分页按钮手机端触摸目标 ≥44px；
 * - 规则 10：表格保持列宽（min-width: max-content 兜底），容器内横滑，页面无整体横向滚动；
 * - 规则 3：Dialog 手机端左右边距 + 滚动。
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

const PROJECTS = [{ id: 1, name: 'E2E 测试项目' }]

const LONG_TEXT =
  '这是一个用来验证手机端长文本列不会被压缩折行撑破视口的超长备注内容，包含中文与英文混合，确保表格容器内横滑承接而不是页面整体横向滚动'

// ── inventory-ledger mocks ───────────────────────────────────────────────────

const LEDGER_MONTHS = { months: ['2026-07', '2026-06'] }

const LEDGER_SUMMARY_ROWS = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  date: `2026-07-${String(20 + i).padStart(2, '0')}`,
  fnsku: null,
  asin: null,
  msku: `E2E-MSKU-${i + 1}`,
  title: `测试品名 ${i + 1} ${LONG_TEXT}`,
  disposition: 'SELLABLE',
  location: 'PHX7',
  starting_balance: 100 + i,
  in_transit_between: 10,
  receipts: 20,
  customer_shipments: 5,
  customer_returns: 1,
  vendor_returns: 0,
  warehouse_transfer_io: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other_events: 0,
  unknown_events: 0,
  ending_balance: 120 + i,
  store: null,
  batch_id: i + 1,
}))

const LEDGER_DETAIL_ROWS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  date: `2026-07-${String(20 + i).padStart(2, '0')}`,
  fnsku: null,
  asin: null,
  msku: `E2E-MSKU-${i + 1}`,
  title: `测试品名 ${i + 1}`,
  event_type: 'Receipts',
  reference_id: `REF-${i + 1}`,
  quantity: i % 2 === 0 ? 10 : -2,
  fulfillment_center: 'PHX7',
  disposition: 'SELLABLE',
  reason: null,
  country: 'US',
  reconciled_quantity: 10,
  unreconciled_quantity: 0,
  date_and_time: `2026-07-${String(20 + i).padStart(2, '0')}T08:00:00Z`,
  store: null,
  batch_id: i + 1,
}))

const LEDGER_SNAPSHOT = {
  report_month: '2026-07',
  sku_count: 8,
  total_qty: 1016,
  disposition_summary: [
    { disposition: 'SELLABLE', qty_eom: 1016, pct_of_total: 100 },
  ],
  skus: Array.from({ length: 8 }, (_, i) => ({
    msku: `E2E-MSKU-${i + 1}`,
    title: `测试品名 ${i + 1}`,
    qty_eom: 120 + i,
    sellable_qty: 120 + i,
    damaged_qty: 0,
    prev_qty_eom: 100 + i,
    change: 20,
  })),
  integrity: { report_month: '2026-07', status: 'OK', mismatch_count: 0, mismatches: [], comparisons: [], checked_at: '2026-08-01T00:00:00Z' },
}

const LEDGER_TREND = {
  project_id: 1,
  months: [
    { report_month: '2026-02', sku_count: 8, total_qty_eom: 1000, total_receipts: 100, total_shipments: 50, total_returns: 5, total_damaged: 0, total_lost: 0, total_disposed: 0, damaged_pct: 0 },
    { report_month: '2026-03', sku_count: 8, total_qty_eom: 1005, total_receipts: 100, total_shipments: 50, total_returns: 5, total_damaged: 0, total_lost: 0, total_disposed: 0, damaged_pct: 0 },
    { report_month: '2026-04', sku_count: 8, total_qty_eom: 1010, total_receipts: 100, total_shipments: 50, total_returns: 5, total_damaged: 0, total_lost: 0, total_disposed: 0, damaged_pct: 0 },
  ],
}

const LEDGER_BATCHES = {
  batches: [
    {
      id: 1,
      project_id: 1,
      report_month: '2026-07',
      source_filename: `E2E 批次文件 ${LONG_TEXT}.csv`,
      file_hash: 'abc123',
      file_size_bytes: 1024,
      file_kind: 'summary',
      loaded_by: 'E2E',
      loaded_at: '2026-08-01T08:00:00Z',
      completed_at: '2026-08-01T08:00:01Z',
      status: 'success',
      rows_parsed: 8,
      rows_written_summary: 8,
      rows_written_detail: 6,
      rows_skipped_duplicate: 0,
      rows_failed_validation: 0,
      error_message: null,
      consistency_check: 'ok',
    },
  ],
}

const LEDGER_CONSISTENCY = {
  report_month: '2026-07',
  status: 'OK',
  mismatches: [],
  checked_at: '2026-08-01T00:00:00Z',
}

// ── shipment-management mocks ────────────────────────────────────────────────

const SHIPMENT_LIST = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  project_id: 1,
  project_name: 'E2E 测试项目',
  country: 'US',
  shipment_no: `FBA19${i}N7ZW`,
  tracking_no: '1Z999AA10123456784',
  warehouse_code: 'PHX7',
  forwarder_name: '测试货代',
  shipping_method: 'sea',
  created_date: '2026-07-01',
  etd_date: '2026-07-10',
  eta_date: '2026-08-10',
  actual_inbound_date: null,
  shipment_status: 'in_transit',
  remark: null,
  sku_count: 3,
  total_quantity: 1000 + i * 10,
  logistics_unit_price: 8.5,
  total_volume_m3: 3.2,
  total_chargeable_weight_kg: 400,
  logistics_total_price: 3400,
  include_in_history_shipping_calc: true,
  updated_at: '2026-07-02T00:00:00Z',
  shipment_batch: '2026-07 批次',
}))

const SHIPMENT_LIST_RESPONSE = {
  items: SHIPMENT_LIST,
  page: 1,
  page_size: 20,
  total: SHIPMENT_LIST.length,
  has_next: false,
}

const COST_SUMMARY = {
  shipment_count: 5,
  total_quantity: 5050,
  total_chargeable_weight_kg: 2000,
  total_logistics_cost: 17000,
}

const SKU_SUMMARY_RESPONSE = {
  items: Array.from({ length: 4 }, (_, i) => ({
    sku: `E2E-SKU-${i + 1}`,
    total_quantity: 100 * (i + 1),
    total_chargeable_weight_kg: 400,
    total_logistics_cost: 3400,
    shipment_count: 2,
    // sku-info 消费方需要的字段（历史头程成本合并用）
    average_logistics_unit_price: 8.5,
  })),
}

const FBA_BOX_RESPONSE = {
  items: Array.from({ length: 4 }, (_, i) => ({
    shipment_no: `FBA19${i}N7ZW`,
    tracking_no: `TRK${i + 1}`,
    warehouse_code: 'PHX7',
    sku: `E2E-SKU-${i + 1}`,
    product_image_thumbnail_r2_url: null,
    length_cm: 50,
    width_cm: 40,
    height_cm: 30,
    carton_weight_kg: 15,
    units_per_carton: 10,
    carton_count: 10,
    quantity: 100,
    total_volume_m3: 0.6,
    total_weight_kg: 150,
  })),
  summary: { totalCartons: 40, totalWeightKg: 600, totalVolumeM3: 2.4 },
}

// ── sku-info mocks ───────────────────────────────────────────────────────────

const SKU_INFO_ITEMS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  project_name: 'E2E 测试项目',
  sku: `E2E-SKU-${i + 1}`,
  asin: `B0${String(100 + i).padStart(7, '0')}`,
  fnsku: `X00${i + 1}YZW`,
  product_name: `测试产品 ${i + 1} ${LONG_TEXT}`,
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
  country: 'US',
  sort_order: i + 1,
  is_active: true,
  updated_at: '2026-07-01T00:00:00Z',
  sku_factory_info: null,
  sku_factory_info_updated_by: null,
  sku_factory_info_updated_at: null,
  fnsku_label_r2_key: null,
}))

const SKU_INFO_RESPONSE = {
  items: SKU_INFO_ITEMS,
  total: SKU_INFO_ITEMS.length,
  page: 1,
  page_size: 10000,
  has_next: false,
}

// ── 页面级无整体横向滚动（允许 ±2px 误差） ───────────────────────────────────

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

async function mockOpsBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))

  // 单 catch-all 分发（避免 glob `?` 单字符通配与子路径误匹配）：按 URL 精确路由。
  await page.route('**/api/backend/api/v1/**', (route) => {
    const url = route.request().url()
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    let matched = true
    let json: unknown
    if (path.includes('/projects/manage')) json = PROJECTS
    else if (path.includes('/inventory-ledger/months')) json = LEDGER_MONTHS
    else if (path.includes('/inventory-ledger/snapshot')) json = LEDGER_SNAPSHOT
    else if (path.includes('/inventory-ledger/trend')) json = LEDGER_TREND
    else if (path.includes('/inventory-ledger/summary')) {
      json = { report_month: '2026-07', rows: LEDGER_SUMMARY_ROWS }
    } else if (path.includes('/inventory-ledger/detail')) {
      json = { report_month: '2026-07', rows: LEDGER_DETAIL_ROWS }
    } else if (path.includes('/inventory-ledger/batches')) json = LEDGER_BATCHES
    else if (path.includes('/inventory-ledger/consistency')) json = LEDGER_CONSISTENCY
    else if (path.includes('/shipment-schedules/cost-summary')) json = COST_SUMMARY
    else if (path.includes('/shipment-schedules/sku-summary')) json = SKU_SUMMARY_RESPONSE
    else if (path.includes('/shipment-schedules/fba-box-details')) json = FBA_BOX_RESPONSE
    else if (path.includes('/shipment-schedules/')) {
      // 单个货件详情：返回列表首条 + 空 items（编辑弹窗用）
      json = { ...SHIPMENT_LIST[0], items: [] }
    } else if (path.includes('/shipment-schedules')) json = SHIPMENT_LIST_RESPONSE
    else if (path.includes('/sku-info')) json = SKU_INFO_RESPONSE
    else {
      matched = false
      json = { detail: 'not mocked in blf613 fixture' }
    }
    return route.fulfill({ json, status: matched ? 200 : 404 })
  })
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'mobile-blf613 仅在 mobile project 运行（断言依赖手机端视口）'
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

test.describe('@mobile-blf613 inventory-ledger 手机端（BLF-613）', () => {
  test('KPI 卡一行两个 + 表格容器内横滑不折行 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/inventory-ledger?project_id=1&month=2026-07')

    // 等数据加载（KPI 出现）
    const kpi = page.locator('div.dashboard-surface', { hasText: '期末总库存' }).first()
    await expect(kpi).toBeVisible({ timeout: 30000 })

    // KPI 卡：前两张同一行（grid-cols-2 总则 1）
    const kpiCards = page.locator('div.dashboard-surface', {
      hasText: /期末总库存|环比变动|损坏占比|事件净变动/,
    })
    const boxes = []
    for (let i = 0; i < 4; i += 1) {
      const box = await kpiCards.nth(i).boundingBox()
      if (box) boxes.push(box)
    }
    expect(boxes.length).toBeGreaterThanOrEqual(4)
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2)
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + 10)
    const viewport = page.viewportSize()!
    expect(boxes[0].width).toBeLessThan(viewport.width * 0.7)

    // 汇总水位明细表：容器内横滑、单元格不折行（规则 10）
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

  test('分页按钮手机端触摸目标 ≥44px（规则 5）', async ({ page }) => {
    await page.goto('/dashboard/operations/inventory-ledger?project_id=1&month=2026-07')
    await expect(page.locator('div.dashboard-surface', { hasText: '期末总库存' }).first()).toBeVisible({
      timeout: 30000,
    })

    const prevBtn = page.getByRole('button', { name: '上一页' })
    await expect(prevBtn).toBeVisible()
    const box = (await prevBtn.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.width).toBeGreaterThanOrEqual(44)
  })
})

test.describe('@mobile-blf613 shipment-management 手机端（BLF-613）', () => {
  test('统计条手机端 2×2 网格（规则 4）+ 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/shipment-management')

    // 等概览表格渲染
    await expect(page.getByText('船期批次总览').first()).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('FBA19').first()).toBeVisible({ timeout: 15000 })

    // 切到发货费用 tab：统计条 4 项呈 2×2（前两项同行、第三项换行）
    await page.getByRole('tab', { name: '发货费用' }).click()
    await expect(page.getByText('批次', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    const statLabels = ['批次', '数量', '重量', '总运费']
    const statBoxes: { y: number }[] = []
    for (const label of statLabels) {
      const cell = page.getByText(label, { exact: true }).first()
      await expect(cell).toBeVisible()
      const box = (await cell.boundingBox())!
      statBoxes.push(box)
    }
    // 第一行：批次 + 数量；第二行：重量 + 总运费
    expect(Math.abs(statBoxes[0].y - statBoxes[1].y)).toBeLessThan(2)
    expect(statBoxes[2].y).toBeGreaterThan(statBoxes[0].y + 10)
    expect(Math.abs(statBoxes[2].y - statBoxes[3].y)).toBeLessThan(2)

    // Tab 过渡动画结束后再断言页面溢出（过渡期间 TabsTrigger 瞬时超宽，非布局缺陷）
    await page.waitForTimeout(600)
    await expectNoPageHorizontalOverflow(page)
  })

  test('新建批次 Dialog 手机端有边距 + 可滚动（规则 3）', async ({ page }) => {
    await page.goto('/dashboard/operations/shipment-management')
    await expect(page.getByText('船期批次总览').first()).toBeVisible({ timeout: 30000 })

    await page.getByRole('button', { name: '新建批次' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15000 })

    const box = (await dialog.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.width).toBeLessThanOrEqual(viewport.width - 24)
    expect(box.height).toBeLessThanOrEqual(viewport.height - 24)
  })
})

test.describe('@mobile-blf613 sku-info 手机端（BLF-613 规则 10）', () => {
  test('原生表格保持列宽：容器内横滑、单元格不折行、页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/sku-info?project_name=E2E 测试项目')

    const table = page.locator('table').first()
    await expect(table).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('E2E-SKU-1').first()).toBeVisible({ timeout: 15000 })

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

    // 单元格无意外折行：文本单元格单行显示（max-content 兜底让列宽撑到内容宽度）
    const wrapped = await table.evaluate((el) => {
      const tds = Array.from(el.querySelectorAll('tbody td:not(:has(input)):not(:has(button))')).slice(0, 30)
      return tds.filter((td) => {
        const text = (td.textContent ?? '').trim()
        if (!text) return false
        // 单行文本：scrollHeight 应接近 clientHeight（无折行）；多行才会明显更高
        return td.scrollHeight > td.clientHeight + 2
      }).length
    })
    expect(wrapped, '表格单元格不应意外折行（max-content 兜底）').toBe(0)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf613 桌面零回归（BLF-613）', () => {
  test('shipment-management 1440px：统计条横向一排四列（divide-x 恢复）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/operations/shipment-management')

    await expect(page.getByText('船期批次总览').first()).toBeVisible({ timeout: 30000 })
    await page.getByRole('tab', { name: '发货费用' }).click()
    await expect(page.getByText('批次', { exact: true }).first()).toBeVisible({ timeout: 15000 })

    // 桌面：4 项同一行（sm:flex 恢复 divide-x 横排）
    const statBoxes: { y: number }[] = []
    for (const label of ['批次', '数量', '重量', '总运费']) {
      const cell = page.getByText(label, { exact: true }).first()
      await expect(cell).toBeVisible()
      const box = (await cell.boundingBox())!
      statBoxes.push(box)
    }
    expect(Math.abs(statBoxes[0].y - statBoxes[3].y)).toBeLessThan(2)

    // Tab 过渡动画结束后再断言页面溢出（过渡期间 TabsTrigger 瞬时超宽，非布局缺陷）
    await page.waitForTimeout(600)
    await expectNoPageHorizontalOverflow(page)
  })
})
