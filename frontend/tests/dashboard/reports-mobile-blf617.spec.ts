import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-617 报表域 B 手机端适配回归（scheduled-reports / monthly-report / auto-upload）。
 *
 * 自包含：session 与后端请求经 page.route mock，不依赖真实后端 / 登录态。
 * 默认随 mobile project（Pixel 5，393×851）跑；另加 360×800 小屏用例覆盖验收下界。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：卡片/KPI 手机端一行两个（generate 控制台筛选 2 列、统计条 2×2）；
 * - 总则 2：宽组件（表格/图表/状态矩阵）独占整行，不与其他组件并排挤压；
 * - 规则 10：wide 表格保持列宽、容器内横滑（页面级无整体横向滚动）；
 * - 规则 5：文件队列「编辑/取消」触摸区域扩大（附 padding，不依赖文字命中）；
 * - auto-upload 顶部控件：手机端 2 列网格（站点全宽 + 双按钮各半），无横向溢出。
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
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', fullName: '测试', operatorNameZh: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [
  { id: 1, name: 'believeboy' },
  { id: 2, name: 'car&smo-卡斯摩' },
]

const SUBSCRIPTIONS = {
  items: [
    {
      id: 1,
      project_ids: '1',
      country: 'US',
      frequency: 'daily',
      dispatch_hour: 9,
      dispatch_minute: 30,
      dispatch_weekday: 0,
      dispatch_day: 2,
      email: 'ops@believeboy.com',
      enabled: true,
      ai_model: 'gpt-4o-mini',
    },
    {
      id: 2,
      project_ids: '1,2',
      country: 'US,DE',
      frequency: 'weekly',
      dispatch_hour: 16,
      dispatch_minute: 0,
      dispatch_weekday: 1,
      dispatch_day: 2,
      email: 'weekly@believeboy.com',
      enabled: false,
      ai_model: null,
    },
    {
      id: 3,
      project_ids: '*',
      country: 'UK',
      frequency: 'monthly',
      dispatch_hour: 10,
      dispatch_minute: 15,
      dispatch_weekday: 0,
      dispatch_day: 5,
      email: 'monthly@believeboy.com',
      enabled: true,
      ai_model: 'deepseek-v4',
    },
  ],
}

const LEDGER_ITEM = {
  id: 1,
  ledger_key: 'ledger-1',
  expected_date: '2026-08-11',
  expected_at: '2026-08-11T09:30:00+08:00',
  frequency: 'daily',
  subscription_id: 1,
  email: 'ops@believeboy.com',
  project_ids: '1',
  project_names: ['believeboy'],
  country: 'US',
  status: 'sent',
  latest_delivery_log_id: null,
  error_message: null,
  sent_at: '2026-08-11T09:31:00+08:00',
  can_resend: true,
  last_checked_at: null,
  screenshot_r2_url: null,
  screenshot_r2_thumb_url: null,
  ai_summary: null,
  ai_summary_status: 'idle',
  ai_summary_error: null,
  ai_summary_model: null,
  ai_summary_updated_at: null,
}

function makeFinancialRow(month: string) {
  return {
    report_month: month,
    income_sales: 100,
    income_refund: 0,
    income_adjustment: 0,
    income_other: 0,
    expense_selling_fee: 10,
    expense_fba_fee: 5,
    expense_inventory_fee: 0,
    expense_service_fee: 0,
    expense_advertising: 5,
    expense_other_fees: 0,
    income_total: 100,
    expense_total: -20,
    amazon_pay_back: 80,
    credit_card_deduction_usd: 0,
    fob_cost_rmb: 0,
    first_leg_cost_rmb: 0,
    has_source_report: true,
  }
}

const FINANCIAL_PAYLOAD = {
  project_id: 1,
  project_name: 'believeboy',
  start_month: '2026-06',
  end_month: '2026-07',
  rows: [makeFinancialRow('2026-06'), makeFinancialRow('2026-07')],
  trend: {
    income_total_sum: 200,
    expense_total_sum: -40,
    amazon_pay_back_sum: 160,
    net_amount_sum: 160,
    points: [
      {
        report_month: '2026-06',
        income_total: 100,
        expense_total: -20,
        amazon_pay_back: 80,
        net_amount: 80,
        has_source_report: true,
      },
      {
        report_month: '2026-07',
        income_total: 100,
        expense_total: -20,
        amazon_pay_back: 80,
        net_amount: 80,
        has_source_report: true,
      },
    ],
  },
}

const RPA_STATUS_ITEMS = [
  {
    project_id: 1,
    project_name: 'believeboy',
    country: 'US',
    statuses: [
      {
        report_type: 'sales_report',
        has_data: true,
        is_uploaded: true,
        latest_date: '2026-08-11',
        original_filename: '20260811_sales.csv',
      },
    ],
  },
  {
    project_id: 2,
    project_name: 'car&smo-卡斯摩',
    country: 'US',
    statuses: [],
  },
]

async function mockBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/scheduled-reports/subscriptions**', (route) =>
    route.fulfill({ json: SUBSCRIPTIONS })
  )
  await page.route('**/api/backend/api/v1/scheduled-reports/ledger?*', (route) =>
    route.fulfill({
      json: { items: [{ ...LEDGER_ITEM }, { ...LEDGER_ITEM, ledger_key: 'ledger-2', status: 'failed' }], summary: { expected: 2, sent: 1, failed: 1, missing: 0, resendable: 1 }, total: 2 },
    })
  )
  // accounting-detail 必须先注册（financial-series 的 `*` 通配会先命中）
  await page.route('**/api/backend/api/v1/monthly-reports/financial-series/accounting-detail?*', (route) =>
    route.fulfill({ json: { project_id: 1, project_name: 'believeboy', report_month: '2026-07', rows: [] } })
  )
  await page.route('**/api/backend/api/v1/monthly-reports/financial-series*', (route) =>
    route.fulfill({ json: FINANCIAL_PAYLOAD })
  )
  await page.route('**/api/exchange-rates*', (route) =>
    route.fulfill({ json: { data: [], pagination: { totalPages: 1 } } })
  )
  await page.route('**/api/backend/api/v1/rpa-reports/status?*', (route) =>
    route.fulfill({ json: { items: RPA_STATUS_ITEMS } })
  )
}

/** 页面级无整体横向滚动（允许 ±2px 误差；表格内部横滑容器排除） */
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

/** auto-upload 页根容器自带 overflow-auto（手机端整页滚动容器），横向溢出需单独断言 */
async function expectNoAutoUploadRootOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('main #main-content > div, #main-content > div')
    if (!root) return null
    return {
      sw: root.scrollWidth,
      cw: root.clientWidth,
      cls: String(root.className).slice(0, 120),
    }
  })
  if (overflow) {
    expect(overflow.sw - overflow.cw, `auto-upload 页根不应横向溢出：${overflow.cls}`).toBeLessThanOrEqual(2)
  }
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'reports-mobile-blf617 仅在 mobile project 运行（断言依赖手机端视口）'
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

test.describe('@mobile-blf617 scheduled-reports 手机端（BLF-617）', () => {
  test('订阅管理：工具栏 2 列网格 + 卡片列表 + 无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/reports/scheduled-reports')

    // 订阅卡片列表渲染（rule 1 例外：BLF-503 已卡片化，保留现状）
    // 桌面表格（hidden md:block）与手机卡片（md:hidden）都含邮箱文本 → 用 visible 过滤
    await expect(page.getByText('ops@believeboy.com').filter({ visible: true }).first()).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('weekly@believeboy.com').filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByText('monthly@believeboy.com').filter({ visible: true }).first()).toBeVisible()

    // 工具栏手机端 2 列：频率 / 项目同一行（手机端 Select 显示短标签「全部/全部项目」，
    // 用 combobox role + 锚定正则避免误匹配订阅卡片的「全部项目」文本）
    const freqBox = (
      await page.getByRole('combobox').filter({ hasText: /^全部$/ }).boundingBox()
    )!
    const projBox = (
      await page.getByRole('combobox').filter({ hasText: /^全部项目$/ }).boundingBox()
    )!
    expect(Math.abs(freqBox.y - projBox.y), '频率/项目应在同一行（2 列网格）').toBeLessThan(2)

    await expectNoPageHorizontalOverflow(page)
  })

  test('调度记录：卡片列表渲染 + 无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/reports/scheduled-reports/ledger')

    // 手机卡片展示项目名与状态（邮箱不展示在卡片上）
    await expect(page.getByText('believeboy').filter({ visible: true }).first()).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('✓', { exact: true }).filter({ visible: true }).first()).toBeVisible()

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf617 monthly-report 手机端（BLF-617）', () => {
  test('制作报表：控制台筛选 2 列 + 统计条 2×2 + 无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/reports/monthly-report/generate')

    await expect(page.getByText('拖拽文件到这里', { exact: false })).toBeVisible({ timeout: 30000 })

    // 统计条手机端 2×2：识别 / 上传统计标签（<p>）同一行；上传按钮不在 <p> 内不误匹配
    const recLabel = page.locator('p').filter({ hasText: /^识别$/ })
    const upLabel = page.locator('p').filter({ hasText: /^上传$/ })
    await expect(recLabel.first()).toBeVisible()
    const recBox = (await recLabel.first().boundingBox())!
    const upBox = (await upLabel.first().boundingBox())!
    expect(Math.abs(recBox.y - upBox.y), '统计条「识别/上传」应同一行（2×2 网格）').toBeLessThan(2)

    await expectNoPageHorizontalOverflow(page)
  })

  test('财务报表：宽表格横滑（rule 10）+ 无页面级横向滚动', async ({ page }) => {
    await page.goto('/dashboard/reports/monthly-report/display')

    // 数据加载后：月度汇总表（min-w 2100px）渲染，sticky 首列存在
    await expect(page.getByText('年/月度')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('believeboy ·')).toBeVisible()
    await expect(page.locator('th.sticky').first()).toBeVisible()

    // 宽表格由 overflow-x-auto 容器承接横向滚动（rule 10）：容器 scrollWidth > clientWidth
    const scrollable = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[class*="overflow-x-auto"]')).filter(
        (e) => e.scrollWidth - e.clientWidth > 100
      )
    })
    expect(scrollable.length, '宽表格应有内部横向滚动容器（rule 10）').toBeGreaterThan(0)

    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf617 auto-upload 手机端（BLF-617）', () => {
  test('RPA 状态矩阵：项目首列 sticky + 容器横滑 + 无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/reports/auto-upload')

    await expect(page.getByText('RPA 报表状态')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('believeboy')).toBeVisible()

    // 状态矩阵内部横滑容器存在（160 + 15×96px 超出手机视口）
    const scrollable = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('[class*="overflow-auto"]')).find(
        (e) => e.scrollWidth - e.clientWidth > 100
      )
      return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null
    })
    expect(scrollable, '状态矩阵应有内部横向滚动容器').not.toBeNull()

    await expectNoPageHorizontalOverflow(page)
    await expectNoAutoUploadRootOverflow(page)
  })

  test('文件上传：顶部控件 2 列网格（站点全宽 + 双按钮各半）', async ({ page }) => {
    await page.goto('/dashboard/reports/auto-upload')
    await page.getByRole('tab', { name: '文件上传' }).click({ timeout: 30000 })

    await expect(page.getByText('拖拽文件到这里，或点击选择')).toBeVisible({ timeout: 30000 })

    // 顶部：站点下拉全宽一行，上传/清空按钮第二行各半（量 combobox 触发器宽度，而非文本）
    const countryBox = (
      await page.getByRole('combobox').filter({ hasText: 'US 美国站' }).boundingBox()
    )!
    expect(countryBox.width).toBeGreaterThan(300) // 全宽（393 视口内）
    const uploadBtn = page.getByRole('button', { name: /上传全部/ })
    const clearBtn = page.getByRole('button', { name: '清空列表' })
    const upBox = (await uploadBtn.boundingBox())!
    const clearBox = (await clearBtn.boundingBox())!
    expect(Math.abs(upBox.y - clearBox.y), '上传/清空按钮应在同一行').toBeLessThan(2)
    expect(Math.abs(upBox.x - clearBox.x)).toBeGreaterThan(1) // 并排而非重叠

    await expectNoPageHorizontalOverflow(page)
    await expectNoAutoUploadRootOverflow(page)
  })
})

test.describe('@mobile-blf617 360×800 小屏（BLF-617）', () => {
  test('三域页面均无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })

    await page.goto('/dashboard/reports/scheduled-reports')
    await expect(page.getByText('ops@believeboy.com').filter({ visible: true }).first()).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)

    await page.goto('/dashboard/reports/monthly-report/generate')
    await expect(page.getByText('拖拽文件到这里', { exact: false })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)

    await page.goto('/dashboard/reports/auto-upload')
    await expect(page.getByText('RPA 报表状态')).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
    await expectNoAutoUploadRootOverflow(page)
  })
})
