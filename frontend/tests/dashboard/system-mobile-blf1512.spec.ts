import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-1512 Stage 8 手机端回归：系统管理 9 页 + 个人 / 更新 / 表格展示 4 页。
 *
 * 自包含：session 与 backend 请求全部 page.route mock。断言集中在手机端
 * 布局契约（标题/操作堆叠、表格自有横滑、Dialog 底部面板、2 列 KPI、
 * 单列表单），以及页面级无横向溢出。桌面几何不在本 spec 的范围。
 */

const FIXTURE_SECRET = BLF611_FIXTURE_SECRET

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
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

const MANAGE_PROJECTS = [
  {
    id: 1,
    name: 'E2E 测试店铺',
    brand_name: 'E2E',
    country: 'US',
    project_operator: '张三',
    assistant_operator: '李四',
    commission_basis: 'profit',
    commission_rate: 0.12,
    store_address: 'https://example.com/store',
    is_active: true,
    has_context: true,
    project_tier: 'S',
    sort_order: 1,
  },
]

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

const ALERT_STATS = {
  total_active: 3,
  critical_count: 1,
  warning_count: 1,
  info_count: 1,
  acknowledged_today: 2,
  resolved_today: 1,
}

const ALERT_EVENTS = {
  items: [
    {
      id: 1,
      triggered_at: '2026-08-10T10:00:00Z',
      metric: 'sales_amount',
      message: 'US 销售额较上周下降 24%',
      deviation_pct: -24,
      severity: 'warning',
      status: 'active',
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
  has_next: false,
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

const ALERT_PREFERENCES = {
  email_enabled: true,
  in_app_enabled: true,
  min_severity: 'warning',
  quiet_hours_start: null,
  quiet_hours_end: null,
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
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
      before_json: null,
      after_json: null,
      error_message: null,
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
  has_next: false,
}

const AUDIT_SUMMARY = {
  total: 1,
  success_count: 1,
  failure_count: 0,
  unique_operator_count: 1,
  modules: [],
  top_actions: [],
}

const DATA_STATUS = {
  server_time: '2026-11-04T12:00:00Z',
  database: {
    engine: 'postgresql',
    source: 'BLF',
    healthy: true,
    checked_at: '2026-11-04T11:59:00Z',
  },
  cache_enabled: true,
  summary: {
    total_tables: 12,
    total_rows: 34567,
    stale_tables: 1,
    data_status: 'active',
  },
  data_status_note: null,
  data_status_updated_at: '2026-11-04T10:00:00Z',
  data_status_updated_by: 'admin',
}

const DATA_OVERVIEW = {
  ...DATA_STATUS,
  tables: [
    {
      table_name: 'orders',
      table_name_cn: '订单',
      row_count: 42,
      last_updated_at: '2026-11-04T11:30:00Z',
      status: 'healthy',
      note: null,
    },
  ],
  recent_statuses: [],
}

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

const PROFILE = {
  id: '1',
  email: 'e2e@example.com',
  name: 'yawei',
  full_name: 'Yawei',
  is_admin: true,
  is_active: true,
  role_type: 'admin',
  avatar_url: 'https://static.example.com/avatar.png',
  password_changed_at: '2026-01-01T00:00:00Z',
}

async function mockBase(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/v1/notifications/unread-count', (route) =>
    route.fulfill({ json: { count: 0 } })
  )
  // 只在确切的项目列表路由上返回 { items }，避免吃掉 manage / operator-options / context。
  await page.route(/\/api\/backend\/api\/v1\/projects(\?|$)/, (route) =>
    route.fulfill({ json: { items: PROJECTS } })
  )
  await page.route(/\/api\/backend\/api\/v1\/projects\/manage(\?|$)/, (route) =>
    route.fulfill({ json: MANAGE_PROJECTS })
  )
  await page.route(/\/api\/backend\/api\/v1\/projects\/operator-options(\?|$)/, (route) =>
    route.fulfill({ json: ['张三', '李四'] })
  )
}

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

async function expectSameRow(
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(Math.abs(ba.y - bb.y), label).toBeLessThan(2)
}

async function expectStacked(
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(bb.y, label).toBeGreaterThan(ba.y + ba.height - 2)
}

async function expectBottomSheet(page: import('@playwright/test').Page) {
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'))
  await expect(dialog).toBeVisible({ timeout: 15000 })
  const box = (await dialog.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeLessThanOrEqual(2)
  expect(box.width).toBeGreaterThan(viewport.width - 24)
  expect(box.y + box.height).toBeGreaterThan(viewport.height - 24)
  return dialog
}

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'BLF-1512 仅在手机视口运行')
})

test.beforeEach(async ({ context }) => {
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

test.describe('@mobile-blf1512 系统管理', () => {
  test('账号管理：操作按钮堆叠、表格横滑、Dialog 底部面板', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/admin/users', (route) => route.fulfill({ json: USERS }))
    await page.goto('/dashboard/system/account-management')

    const root = page.locator('[data-warm-account-management="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('Yawei', { exact: true })).toBeVisible()

    await expectSameRow(
      page.getByRole('button', { name: '刷新' }),
      page.getByRole('button', { name: '新增账号' }),
      '刷新与新增账号按钮同一行'
    )
    const panelBox = (await root.locator('section').first().boundingBox())!
    const addBox = (await page.getByRole('button', { name: '新增账号' }).boundingBox())!
    expect(addBox.width).toBeGreaterThan(panelBox.width * 0.4)

    const scroller = root.locator('table').locator('..')
    const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow, '账号表格应保留自身横向滚动').toBeGreaterThan(100)

    await page.getByRole('button', { name: '新增账号' }).click()
    await expectBottomSheet(page)
    await expectNoPageHorizontalOverflow(page)
  })

  test('Agent 接入：2×2 Tab、2 列业务域卡片、凭据表横滑', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/internal/api-keys**', (route) =>
      route.fulfill({ json: AGENT_KEYS })
    )
    await page.goto('/dashboard/system/agent-management')

    const root = page.locator('[data-warm-agent-management="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('业务域接入一览')).toBeVisible({ timeout: 15000 })

    const tab1 = page.getByRole('tab', { name: '业务域概览' })
    const tab2 = page.getByRole('tab', { name: '凭据管理' })
    const tab3 = page.getByRole('tab', { name: '调用指南' })
    await expectSameRow(tab1, tab2, '前两个 Tab 同一行')
    await expectStacked(tab1, tab3, '第 3 个 Tab 换行')

    const firstCard = root.locator('[class*="domainCard"]').first()
    const secondCard = root.locator('[class*="domainCard"]').nth(1)
    const thirdCard = root.locator('[class*="domainCard"]').nth(2)
    await expectSameRow(firstCard, secondCard, '业务域卡片一行两个')
    await expectStacked(firstCard, thirdCard, '第 3 张业务域卡片换行')

    await tab2.click()
    await expect(page.getByText('货件助理 (生产)')).toBeVisible({ timeout: 15000 })
    const scroller = root.locator('table').locator('..')
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100)
    await expectNoPageHorizontalOverflow(page)
  })

  test('告警中心：2 列统计、3 列 Tab、规则 Dialog 单列表单', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/alerts/stats**', (route) => route.fulfill({ json: ALERT_STATS }))
    await page.route('**/api/v1/alerts/events**', (route) => route.fulfill({ json: ALERT_EVENTS }))
    await page.route('**/api/v1/alerts/rules**', (route) => route.fulfill({ json: ALERT_RULES }))
    await page.route('**/api/v1/alerts/metrics**', (route) =>
      route.fulfill({ json: { metrics: [{ value: 'sales_amount', label: '销售额' }] } })
    )
    await page.route('**/api/v1/alerts/preferences**', (route) =>
      route.fulfill({ json: ALERT_PREFERENCES })
    )
    await page.goto('/dashboard/system/alerts')

    const root = page.locator('[data-warm-alerts="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('活跃告警')).toBeVisible()

    const stats = root.locator('[class*="statCard"]')
    await expectSameRow(stats.nth(0), stats.nth(1), '统计卡一行两个')
    await expectStacked(stats.nth(0), stats.nth(2), '第 3 张统计卡换行')

    const tab1 = page.getByRole('tab', { name: '告警事件' })
    const tab2 = page.getByRole('tab', { name: '告警规则' })
    const tab3 = page.getByRole('tab', { name: '通知偏好' })
    await expectSameRow(tab1, tab2, '告警 Tab 同一行')
    await expectSameRow(tab1, tab3, '告警 Tab 同一行（第三项）')

    await page.getByRole('tab', { name: '告警规则' }).click()
    await expect(page.getByText('US 销售额骤降告警', { exact: false })).toBeVisible({
      timeout: 15000,
    })
    await page.getByRole('button', { name: '新建规则' }).click()
    const dialog = await expectBottomSheet(page)
    await expect(dialog.getByText('阈值 (%)')).toBeVisible()
    await expectStacked(
      dialog.getByText('阈值 (%)'),
      dialog.getByText('窗口 (天)'),
      '阈值与窗口在单列表单中纵向排列'
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('更新日志：导航上移横滑、亮点卡单列', async ({ page }) => {
    await mockBase(page)
    await page.goto('/dashboard/system/changelog')

    const root = page.locator('[data-warm-changelog="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })

    const navigation = page.getByRole('navigation', { name: 'Changelog release navigation' })
    expect(await navigation.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100)

    const firstRelease = root.locator('[class*="releasePanel"]').first()
    await expect(firstRelease).toBeVisible()
    const firstHighlight = firstRelease.locator('[class*="highlightCard"]').nth(0)
    const secondHighlight = firstRelease.locator('[class*="highlightCard"]').nth(1)
    await expectStacked(firstHighlight, secondHighlight, '亮点卡在手机上单列排列')
    await expectNoPageHorizontalOverflow(page)
  })

  test('数据库状态：双按钮一行、2 列表概览、表状态横滑', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/backend/api/v1/system-management/data-management/status**', (route) =>
      route.fulfill({ json: DATA_STATUS })
    )
    await page.route('**/api/backend/api/v1/system-management/data-management/overview**', (route) =>
      route.fulfill({ json: DATA_OVERVIEW })
    )
    await page.goto('/dashboard/system/data-management')

    const root = page.locator('[data-warm-data-management="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('数据表状态')).toBeVisible()
    await expectSameRow(
      page.getByRole('button', { name: '刷新状态' }),
      page.getByRole('button', { name: '清理缓存' }),
      '刷新与清理缓存同一行'
    )

    const cards = root.locator('[class*="summaryCard"]')
    await expectSameRow(cards.nth(0), cards.nth(1), '概览卡一行两个')
    await expectStacked(cards.nth(0), cards.nth(2), '第 3 张概览卡换行')

    const scroller = root.locator('table').locator('..')
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100)
    await expectNoPageHorizontalOverflow(page)
  })

  test('数字大屏：保留强制暗色全屏展示，KPI 两列、详情单列', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/digital-display/**', (route) =>
      route.fulfill({ json: DISPLAY_DATA })
    )
    await page.goto('/dashboard/system/digital-display')

    await expect(page.getByText('今日订单量')).toBeVisible({ timeout: 30000 })
    const kpi1 = page.getByText('今日订单量')
    const kpi2 = page.getByText('今日销售额')
    const kpi3 = page.getByText('今日会话')
    await expectSameRow(kpi1, kpi2, '前两个 KPI 同一行')
    await expectStacked(kpi1, kpi3, '第 3 个 KPI 换行')

    await expectStacked(page.getByText('库存概况'), page.getByText('发货在途'), '详情卡单列')

    const darkState = await page.evaluate(() => ({
      hasDark: document.documentElement.classList.contains('dark'),
      hasLight: document.documentElement.classList.contains('light'),
      colorScheme: document.documentElement.style.colorScheme,
    }))
    expect(darkState).toEqual({ hasDark: true, hasLight: false, colorScheme: 'dark' })
    await expect(page.locator('[data-digital-display-exception="true"]')).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })

  test('日志查看：3 列 Tab、单列筛选、详情 Dialog 单列', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/system-management/audit-logs?**', (route) =>
      route.fulfill({ json: AUDIT_LOGS })
    )
    await page.route('**/api/v1/system-management/audit-logs/summary?**', (route) =>
      route.fulfill({ json: AUDIT_SUMMARY })
    )
    await page.goto('/dashboard/system/logs')

    const tab1 = page.getByRole('tab', { name: '操作审计日志' })
    const tab2 = page.getByRole('tab', { name: '登录日志' })
    const tab3 = page.getByRole('tab', { name: 'Agent 访问日志' })
    await expect(tab1).toBeVisible({ timeout: 30000 })
    await expectSameRow(tab1, tab2, '日志 Tab 同一行')
    await expectSameRow(tab1, tab3, '日志 Tab 同一行（第三项）')

    const keyword = page.getByPlaceholder('关键词（动作/路径/资源ID/trace）')
    const operator = page.getByPlaceholder('操作人')
    await expectStacked(operator, page.locator('select').filter({ hasText: '全部分类' }), '筛选项单列')
    await expect(keyword).toBeVisible()

    const table = page.locator('#main-content table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    expect(await table.locator('..').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100)

    await page.getByRole('button', { name: /查看 .* 的日志详情/ }).click()
    const dialog = await expectBottomSheet(page)
    await expect(dialog.getByRole('heading', { name: '日志详情' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })

  test('运营管理：Tab 与月份堆叠、绩效指标两列、表格横滑', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/v1/system-management/commission-management/role-assignments**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.route('**/api/v1/system-management/operator-management/performance**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.goto('/dashboard/system/operator-management')

    const root = page.locator('[data-warm-operator-management="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })

    const tabList = root.locator('[role="tablist"]').first()
    const month = page.locator('#operator-report-month')
    await expectStacked(tabList, month, 'Tab 与月份选择纵向堆叠')
    const tab1 = page.getByRole('tab', { name: '运营信息' })
    const tab2 = page.getByRole('tab', { name: '运营绩效' })
    const tab3 = page.getByRole('tab', { name: '运营佣金' })
    await expectSameRow(tab1, tab2, '运营 Tab 同一行')
    await expectSameRow(tab1, tab3, '运营 Tab 同一行（第三项）')

    const roleTable = page.getByRole('table', { name: '运营岗位列表' })
    await expect(roleTable).toBeVisible()
    expect(await roleTable.locator('..').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(
      100
    )

    await tab2.click()
    await expect(page.getByText('本月绩效记录')).toBeVisible({ timeout: 15000 })
    const recordMetric = page.getByText('本月绩效记录').locator('..')
    const peopleMetric = page.getByText('覆盖人员').locator('..')
    await expectSameRow(recordMetric, peopleMetric, '绩效指标一行两个')
    await expectNoPageHorizontalOverflow(page)
  })

  test('项目信息：标题操作堆叠、宽表横滑、新增 Dialog 单列表单', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/backend/api/v1/projects/1/context**', (route) =>
      route.fulfill({
        json: {
          project_id: 1,
          project_name: 'E2E 测试店铺',
          project_context: {},
          sku_context: null,
        },
      })
    )
    await page.route('**/api/backend/api/v1/project-workflows/summary**', (route) =>
      route.fulfill({ json: { projects: [{ project_id: 1, workflows: [] }] } })
    )
    await page.goto('/dashboard/system/project-info')

    const root = page.locator('[data-warm-project-info="true"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await page.getByRole('tab', { name: '基础信息' }).click()
    await expect(page.getByRole('table', { name: '项目资料列表' })).toBeVisible({
      timeout: 15000,
    })

    await expectSameRow(
      page.getByRole('button', { name: '刷新数据' }),
      page.getByRole('button', { name: '单个新增' }),
      '刷新与单个新增同一行'
    )
    const table = page.getByRole('table', { name: '项目资料列表' })
    expect(await table.locator('..').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(
      100
    )

    await page.getByRole('button', { name: '单个新增' }).click()
    const dialog = await expectBottomSheet(page)
    const nameLabel = dialog.getByText('项目名称', { exact: true })
    const brandLabel = dialog.getByText('品牌名称', { exact: true })
    await expect(nameLabel).toBeVisible()
    await expect(brandLabel).toBeVisible()
    await expectStacked(
      nameLabel,
      brandLabel,
      '新增项目字段单列排列'
    )
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1512 个人与工具页面', () => {
  test('我的资料：3 列 Tab、单列表单、2 列统计、头像纵向堆叠', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/user/profile', (route) => route.fulfill({ json: PROFILE }))
    await page.goto('/dashboard/profile')

    const root = page.locator('[data-warm-page="profile"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('我的资料')).toBeVisible()

    const tab1 = page.getByRole('tab', { name: '资料设置' })
    const tab2 = page.getByRole('tab', { name: '头像' })
    const tab3 = page.getByRole('tab', { name: '我的项目' })
    await expectSameRow(tab1, tab2, '资料 Tab 同一行')
    await expectSameRow(tab1, tab3, '资料 Tab 同一行（第三项）')

    await expectStacked(
      page.getByLabel('邮箱'),
      page.getByLabel('登录名 *'),
      '资料表单单列排列'
    )
    const stats = page.locator('[class*="statCard"]')
    await expectSameRow(stats.nth(0), stats.nth(1), '资料统计一行两个')
    await expectStacked(stats.nth(0), stats.nth(2), '第 3 张统计卡换行')

    await tab2.click()
    await expect(page.getByText('上传新头像', { exact: true })).toBeVisible({ timeout: 15000 })
    await expectStacked(
      page.locator('[class*="avatarFrame"]'),
      page.getByText('上传新头像', { exact: true }),
      '头像与上传面板纵向堆叠'
    )

    await page.getByRole('button', { name: '删除头像' }).click()
    await expectBottomSheet(page)
    await expectNoPageHorizontalOverflow(page)
  })

  test('修改密码：输入与提交按钮贴合手机宽度', async ({ page }) => {
    await mockBase(page)
    await page.goto('/dashboard/change-password')

    const root = page.locator('[data-warm-page="change-password"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    const panel = root.locator('section')
    const panelBox = (await panel.boundingBox())!
    const inputBox = (await page.getByLabel('当前密码').boundingBox())!
    const submitBox = (await page.getByRole('button', { name: '确认修改' }).boundingBox())!
    expect(inputBox.width).toBeGreaterThan(panelBox.width - 40)
    expect(submitBox.width).toBeGreaterThan(panelBox.width - 36)
    expect(submitBox.height).toBeGreaterThanOrEqual(44)
    await expectNoPageHorizontalOverflow(page)
  })

  test('版本更新：亮点卡单列、总结指标两列', async ({ page }) => {
    await mockBase(page)
    await page.goto('/dashboard/feature-updates')

    const root = page.locator('[data-warm-page="feature-updates"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    const cards = root.locator('[class*="featureCard"]')
    await expectStacked(cards.nth(0), cards.nth(1), '版本亮点单列排列')
    const metrics = root.locator('[class*="summaryMetric"]')
    await expectSameRow(metrics.nth(0), metrics.nth(1), '总结指标一行两个')
    await expectNoPageHorizontalOverflow(page)
  })

  test('表格展示：工具栏单列、表格横滑、展开明细单列', async ({ page }) => {
    await mockBase(page)
    await page.goto('/dashboard/table-showcase')

    const root = page.locator('[data-warm-page="table-showcase"]')
    await expect(root).toBeVisible({ timeout: 30000 })
    const search = page.getByPlaceholder('筛选发票或客户...')
    await expect(search).toBeVisible()
    await expectStacked(search, page.getByText('已选 0 / 8'), '搜索与选择计数纵向堆叠')

    const table = root.locator('table').first()
    expect(await table.locator('..').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(
      100
    )

    const expandableRows = root.locator('tbody tr[class*="expandableRow"]')
    await expandableRows.nth(1).click()
    const detail = root.locator('[class*="detailGrid"]').first()
    await expect(detail).toBeVisible()
    const detailItems = detail.locator('> div')
    await expectStacked(detailItems.nth(0), detailItems.nth(1), '展开明细单列排列')
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1512 320px 最小宽度', () => {
  test('13 个页面在 320px 下无页面级横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await mockBase(page)
    await page.route('**/api/admin/users', (route) => route.fulfill({ json: USERS }))
    await page.route('**/api/v1/internal/api-keys**', (route) =>
      route.fulfill({ json: AGENT_KEYS })
    )
    await page.route('**/api/v1/alerts/stats**', (route) => route.fulfill({ json: ALERT_STATS }))
    await page.route('**/api/v1/alerts/events**', (route) => route.fulfill({ json: ALERT_EVENTS }))
    await page.route('**/api/v1/alerts/rules**', (route) => route.fulfill({ json: ALERT_RULES }))
    await page.route('**/api/v1/alerts/metrics**', (route) =>
      route.fulfill({ json: { metrics: [{ value: 'sales_amount', label: '销售额' }] } })
    )
    await page.route('**/api/v1/alerts/preferences**', (route) =>
      route.fulfill({ json: ALERT_PREFERENCES })
    )
    await page.route('**/api/v1/system-management/audit-logs?**', (route) =>
      route.fulfill({ json: AUDIT_LOGS })
    )
    await page.route('**/api/v1/system-management/audit-logs/summary?**', (route) =>
      route.fulfill({ json: AUDIT_SUMMARY })
    )
    await page.route('**/api/v1/system-management/commission-management/role-assignments**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.route('**/api/v1/system-management/operator-management/performance**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.route('**/api/v1/system-management/commission-management/records**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.route('**/api/v1/system-management/commission-management/ratio-overrides**', (route) =>
      route.fulfill({ json: { items: [] } })
    )
    await page.route('**/api/backend/api/v1/system-management/data-management/status**', (route) =>
      route.fulfill({ json: DATA_STATUS })
    )
    await page.route('**/api/backend/api/v1/system-management/data-management/overview**', (route) =>
      route.fulfill({ json: DATA_OVERVIEW })
    )
    await page.route('**/api/v1/digital-display/**', (route) =>
      route.fulfill({ json: DISPLAY_DATA })
    )
    await page.route('**/api/backend/api/v1/project-workflows/summary**', (route) =>
      route.fulfill({ json: { projects: [] } })
    )
    await page.route('**/api/backend/api/v1/projects/1/context**', (route) =>
      route.fulfill({
        json: {
          project_id: 1,
          project_name: 'E2E 测试店铺',
          project_context: {},
          sku_context: null,
        },
      })
    )
    await page.route('**/api/user/profile', (route) => route.fulfill({ json: PROFILE }))

    const routes = [
      '/dashboard/system/account-management',
      '/dashboard/system/agent-management',
      '/dashboard/system/alerts',
      '/dashboard/system/changelog',
      '/dashboard/system/data-management',
      '/dashboard/system/digital-display',
      '/dashboard/system/logs',
      '/dashboard/system/operator-management',
      '/dashboard/system/project-info',
      '/dashboard/profile',
      '/dashboard/change-password',
      '/dashboard/feature-updates',
      '/dashboard/table-showcase',
    ]

    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('#main-content, main').first()).toBeVisible({ timeout: 30000 })
      await expectNoPageHorizontalOverflow(page)
    }
  })
})
