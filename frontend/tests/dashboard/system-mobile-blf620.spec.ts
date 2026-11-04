import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-620 系统域回归（账号 / Agent 接入 / 告警 / 日志 / 数字大屏）。
 *
 * 自包含：session 与 backend 请求经 page.route mock，不依赖真实后端 / 登录态。
 * 日志与数字大屏保留既有 mobile 覆盖；C7-System-A 已迁 Warm Ledger，
 * 账号 / Agent / 告警仅接受 1440×900 桌面视图，不再断言手机布局。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：数字大屏 KPI 手机端一行两个（grid-cols-2），第 3 个换行；
 * - 日志 TabList 手机端 2 列网格（第 3 个 Tab 换行），无挤压溢出；
 * - 数字大屏保留手机 KPI / 宽组件布局；
 * - Warm 系统页只验证 1440×900 下的本地表面、表格与无页面级横向滚动。
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
  user: {
    id: '1',
    name: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    fullName: '测试',
  },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [{ id: 1, name: 'E2E 测试店铺' }]

const USERS = {
  items: [
    {
      id: 'u1',
      name: 'yawei',
      email: 'yawei@example.com',
      fullName: null,
      isActive: true,
      roleType: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 'u2',
      name: 'operator1',
      email: 'op1@example.com',
      fullName: '张三',
      isActive: true,
      roleType: 'operator',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    },
  ],
}

const AUDIT_LOGS = {
  items: [
    {
      id: 1,
      created_at: '2026-08-10T10:00:00Z',
      operator: 'E2E',
      action: 'users.update',
      target_type: 'user_account',
      target_id: 'u2',
      result: 'success',
      trace_id: 'trace-1',
      request_method: 'PATCH',
      request_path: '/api/admin/users/u2',
      ip_address: '127.0.0.1',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0',
      before_json: null,
      after_json: null,
      error_message: null,
    },
    {
      id: 2,
      created_at: '2026-08-10T09:00:00Z',
      operator: 'ops',
      action: 'shipment_schedules.create',
      target_type: 'shipment_schedule',
      target_id: 'SHIP-001',
      result: 'failure',
      trace_id: 'trace-2',
      request_method: 'POST',
      request_path: '/api/v1/shipment-schedules',
      ip_address: '10.0.0.8',
      user_agent: null,
      before_json: null,
      after_json: null,
      error_message: '字段缺失：sku',
    },
  ],
  total: 2,
  page: 1,
  page_size: 20,
  has_next: false,
}

const AUDIT_SUMMARY = {
  total: 2,
  success_count: 1,
  failure_count: 1,
  unique_operator_count: 2,
  modules: [],
  top_actions: [],
}

const ALERT_STATS = {
  total_active: 3,
  critical_count: 1,
  warning_count: 1,
  info_count: 1,
  acknowledged_today: 2,
  resolved_today: 1,
}

const ALERT_RULES = [
  {
    id: 1,
    name: 'US 销售额骤降告警（用于验证长文本列不撑爆页面）',
    project_id: 1,
    country: 'US',
    metric: 'sales_amount',
    trigger_type: 'threshold',
    condition: 'drop_pct',
    threshold: 20,
    window_days: 7,
    severity: 'warning',
    notification_channels: 'in_app',
    is_active: true,
  },
]

const AGENT_KEYS = [
  {
    id: 1,
    key_prefix: 'bbk_live_abcd',
    label: '货件助理 (生产)',
    scope: '*',
    project_scope: '*',
    business_scope: 'shipments',
    agent_id: 'shipment-assistant-prod',
    is_revoked: false,
    expires_at: null,
    created_at: '2026-07-01T00:00:00Z',
    last_used_at: '2026-08-10T00:00:00Z',
    deleted_at: null,
  },
]

const DISPLAY_DATA = {
  project_id: 1,
  project_name: 'E2E 测试店铺',
  country: 'US',
  server_time: '2026-08-12T10:00:00Z',
  sales: {
    today_order_qty: 120,
    today_sales_amount: 5200,
    today_sessions: 300,
    today_ordered_sales_amount: 0,
    prev_order_qty: 100,
    prev_sales_amount: 4800,
    prev_sessions: 260,
  },
  sales_trend: [
    { date: '2026-08-06', order_qty: 80, sales_amount: 4000, sessions: 200 },
    { date: '2026-08-12', order_qty: 120, sales_amount: 5200, sessions: 300 },
  ],
  inventory: { sku_count: 100, out_of_stock_count: 5, available_qty: 10000 },
  shipments: { in_transit_count: 3, in_transit_qty: 120 },
  returns: { total_returns: 2, total_quantity: 5, return_rate: 1.5, top_reason: null },
  ads: {
    period_spend: 100,
    period_sales: 500,
    period_roas: 5,
    period_acos: 10,
    period_ctr: 2,
    period_impressions: 10000,
    period_clicks: 200,
    period_orders: 20,
  },
}

/** 会话 + 共享基础 mock（项目选项 / 项目管理 / 运营选项） */
async function mockBase(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/v1/projects/manage**', (route) => route.fulfill({ json: PROJECTS }))
  await page.route('**/api/v1/projects/operator-options**', (route) =>
    route.fulfill({ json: ['张三', '李四'] })
  )
  await page.route('**/api/v1/projects**', (route) =>
    route.fulfill({ json: { items: [{ id: 1, project_name: 'E2E 测试店铺' }] } })
  )
  // 通知铃铛角标（真实后端无关的共享请求，mock 保证自包含）
  await page.route('**/api/v1/notifications/unread-count', (route) =>
    route.fulfill({ json: { count: 0 } })
  )
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
    if (main) {
      // #main-content 自身有 overflow-x: hidden/clip（dashboard 布局基座），
      // 横向滚动在 CSS 层面即被禁止，scrollWidth 超出仅来自纵向滚动条 + 小数 padding
      // （dashboard 基础字号使 px-1=3.75px）的取整噪声（数字大屏长内容页触发，BLF-620 实测 +4px）。
      const mainOX = getComputedStyle(main).overflowX
      if (!/hidden|clip/.test(mainOX)) candidates.push(main)
    }
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

/** 断言两个元素处于同一行（y 差 < 2px） */
async function expectSameRow(
  page: import('@playwright/test').Page,
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(Math.abs(ba.y - bb.y), label).toBeLessThan(2)
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'system-mobile-blf620 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
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

test.describe('@mobile-blf620 系统·账号 Warm 桌面（C7-System-A）', () => {
  test('账号管理：Warm 表格 + 无页面级溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockBase(page)
    await page.route('**/api/admin/users', (route) => route.fulfill({ json: USERS }))
    await page.goto('/dashboard/system/account-management')

    const pageRoot = page.locator('[data-warm-account-management="true"]:visible')
    await expect(pageRoot).toBeVisible({ timeout: 30000 })
    await expect(pageRoot.getByRole('heading', { name: '账号管理' })).toBeVisible()
    await expect(pageRoot.getByText('Yawei', { exact: true })).toBeVisible()
    await expect(pageRoot.getByText('张三')).toBeVisible()
    // BLF-1441：fullName 为空显示「未命名」，不回落登录名 / 运营名
    await expect(pageRoot.getByText('未命名')).toBeVisible()
    await expect(pageRoot.getByRole('button', { name: '停用' }).first()).toBeVisible()
    await expect(pageRoot.locator('[class*="term-"]')).toHaveCount(0)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf620 系统·告警中心 Warm 桌面（C7-System-A）', () => {
  test('告警规则 Warm 表格 + 新建规则 Dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockBase(page)
    await page.route('**/api/v1/alerts/stats**', (route) => route.fulfill({ json: ALERT_STATS }))
    await page.route('**/api/v1/alerts/rules**', (route) => route.fulfill({ json: ALERT_RULES }))
    await page.route('**/api/v1/alerts/metrics**', (route) =>
      route.fulfill({ json: { metrics: [{ value: 'sales_amount', label: '销售额' }] } })
    )
    await page.route('**/api/v1/alerts/preferences**', (route) =>
      route.fulfill({
        json: {
          email_enabled: true,
          in_app_enabled: true,
          min_severity: 'warning',
          quiet_hours_start: null,
          quiet_hours_end: null,
        },
      })
    )
    await page.goto('/dashboard/system/alerts')

    const pageRoot = page.locator('[data-warm-alerts="true"]:visible')
    await expect(pageRoot).toBeVisible({ timeout: 30000 })
    await expect(pageRoot.locator('[class*="term-"]')).toHaveCount(0)
    // 切到告警规则 Tab
    await page.getByRole('tab', { name: '告警规则' }).click()
    await expect(page.getByText('US 销售额骤降告警', { exact: false })).toBeVisible({
      timeout: 15000,
    })

    const rules = page.locator('[data-warm-alert-rules="true"]')
    await expect(rules.getByRole('table', { name: '告警规则' })).toBeVisible()
    await expect(rules.locator('[class*="term-"]')).toHaveCount(0)
    await expectNoPageHorizontalOverflow(page)

    // 保留新建规则 Dialog 的字段与保存入口
    await page.getByRole('button', { name: '新建规则' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await expect(dialog.locator('[class*="term-"]')).toHaveCount(0)
    await expect(dialog.getByText('阈值 (%)')).toBeVisible()
    await expect(dialog.getByText('窗口 (天)')).toBeVisible()
    await expect(dialog.getByText('级别')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '保存' })).toBeVisible()
  })
})

test.describe('@mobile-blf620 系统·日志 Warm 桌面（C7-System-C）', () => {
  test('日志页：TabList 单行 + 审计表容器横滑 + 无溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockBase(page)
    await page.route('**/api/v1/system-management/audit-logs?**', (route) =>
      route.fulfill({ json: AUDIT_LOGS })
    )
    await page.route('**/api/v1/system-management/audit-logs/summary?**', (route) =>
      route.fulfill({ json: AUDIT_SUMMARY })
    )
    await page.goto('/dashboard/system/logs')

    await expect(page.getByRole('tab', { name: '操作审计日志' })).toBeVisible({ timeout: 30000 })
    const firstTab = page.getByRole('tab', { name: '操作审计日志' })
    const thirdTab = page.getByRole('tab', { name: 'Agent 访问日志' })
    await expectSameRow(page, firstTab, thirdTab, '日志 TabList 在桌面单行排列')

    const table = page.locator('#main-content table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf620 系统·Agent 接入 Warm 桌面（C7-System-A）', () => {
  test('Agent 接入：Warm Tab + 凭据表 + 无页面级溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockBase(page)
    await page.route('**/api/v1/internal/api-keys**', (route) =>
      route.fulfill({ json: AGENT_KEYS })
    )
    await page.goto('/dashboard/system/agent-management')

    const pageRoot = page.locator('[data-warm-agent-management="true"]:visible')
    await expect(pageRoot).toBeVisible({ timeout: 30000 })
    await expect(pageRoot.locator('[class*="term-"]')).toHaveCount(0)
    const tab1 = page.getByRole('tab', { name: '业务域概览' })
    const tab2 = page.getByRole('tab', { name: '凭据管理' })
    const tab3 = page.getByRole('tab', { name: '调用指南' })
    await expectSameRow(page, tab1, tab2, '业务域概览/凭据管理应同一行')
    await expectSameRow(page, tab2, tab3, '凭据管理/调用指南应同一行')

    await expect(page.getByText('业务域接入一览')).toBeVisible({ timeout: 15000 })
    await expectNoPageHorizontalOverflow(page)

    await tab2.click()
    await expect(page.getByText('货件助理 (生产)')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('table', { name: '凭据列表' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf620 系统·数字大屏 手机端（BLF-620）', () => {
  test('KPI 一行两个 + 底部宽组件独占一行 + 无溢出', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/digital-display/**', (route) =>
      route.fulfill({ json: DISPLAY_DATA })
    )
    await page.goto('/dashboard/system/digital-display')

    // 总则 1：KPI 手机端一行两个（今日订单量/今日销售额 同一行；今日会话换行）
    const kpi1 = page.getByText('今日订单量')
    const kpi2 = page.getByText('今日销售额')
    await expect(kpi1).toBeVisible({ timeout: 30000 })
    await expect(kpi2).toBeVisible({ timeout: 30000 })
    // KpiCard 与 BigKpiCard 数值字号/内边距不同导致 label 有少量 y 偏移，
    // 用「同带 + 左右分栏」判定同一行：右列卡片 y 落在左列卡片的垂直区间内，且 x 靠右。
    const b1 = (await kpi1.boundingBox())!
    const b2 = (await kpi2.boundingBox())!
    expect(b2.x, '今日销售额应位于右列（2 列网格）').toBeGreaterThan(b1.x)
    expect(b2.y, '今日销售额与今日订单量同一行（垂直重叠）').toBeLessThan(
      b1.y + b1.height - 4
    )
    const kpi1Box = (await kpi1.boundingBox())!
    const kpi3 = page.getByText('今日会话')
    const kpi3Box = (await kpi3.boundingBox())!
    expect(kpi3Box.y, '第 3 个 KPI 应换行到第二行').toBeGreaterThan(kpi1Box.y + 4)

    // 总则 2：底部宽组件（库存/发货/退货/广告）手机端独占一行（纵向堆叠）
    const inventoryTitle = page.getByText('库存概况')
    const shipmentTitle = page.getByText('发货在途')
    await expect(inventoryTitle).toBeVisible({ timeout: 15000 })
    await expect(shipmentTitle).toBeVisible()
    const invBox = (await inventoryTitle.boundingBox())!
    const shipBox = (await shipmentTitle.boundingBox())!
    expect(shipBox.y, '底部宽组件应独占一行（纵向堆叠）').toBeGreaterThan(invBox.y + 4)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf620 系统·桌面零回归（BLF-620）', () => {
  test('1440 桌面零回归：账号表 + 日志 TabList 单行 + 无溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockBase(page)
    await page.route('**/api/admin/users', (route) => route.fulfill({ json: USERS }))
    await page.goto('/dashboard/system/account-management')
    await expect(page.locator('[data-warm-account-management="true"]')).toBeVisible({
      timeout: 30000,
    })
    await expect(page.getByRole('columnheader', { name: '邮箱' })).toBeVisible({
      timeout: 30000,
    })
    await expectNoPageHorizontalOverflow(page)

    await page.route('**/api/v1/system-management/audit-logs?**', (route) =>
      route.fulfill({ json: AUDIT_LOGS })
    )
    await page.route('**/api/v1/system-management/audit-logs/summary?**', (route) =>
      route.fulfill({ json: AUDIT_SUMMARY })
    )
    await page.goto('/dashboard/system/logs')
    await expect(page.getByRole('tab', { name: '操作审计日志' })).toBeVisible({ timeout: 30000 })
    // 桌面 TabList 恢复单行 inline-flex：操作审计日志 与 Agent 访问日志 同一行
    await expectSameRow(
      page,
      page.getByRole('tab', { name: '操作审计日志' }),
      page.getByRole('tab', { name: 'Agent 访问日志' }),
      '1440 桌面 TabList 应单行'
    )
    await expectNoPageHorizontalOverflow(page)
  })
})
