import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * 定时报告（订阅管理 / 订阅记录 / 编辑弹窗）桌面视觉回归。
 *
 * 自包含：伪造 NextAuth session + 全部后端请求 page.route mock，不依赖真实后端/登录态。
 * 断言可读性关键契约：页面无横向溢出、无示例数据、弹窗背景不透明、分区可见、
 * 「仅生成」与「重新生成」文案正确。截图保存在 Playwright outputDir，便于人工复核。
 */

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', fullName: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

const PROJECTS = [
  { id: 1, name: 'believeboy' },
  { id: 2, name: 'car&smo-卡斯摩' },
  { id: 3, name: '博朗姆' },
]

const SUBSCRIPTIONS = {
  items: [
    {
      id: 1,
      user_id: null,
      user_account_id: null,
      project_ids: '1',
      country: 'US,DE',
      frequency: 'daily',
      dispatch_hour: 15,
      dispatch_minute: 10,
      dispatch_weekday: null,
      dispatch_day: null,
      email: null,
      enabled: true,
      ai_model: 'DeepSeek-V4-Flash',
      created_at: '2026-05-24T00:00:00+08:00',
      updated_at: '2026-11-17T14:50:00+08:00',
    },
    {
      id: 2,
      user_id: null,
      user_account_id: null,
      project_ids: '2',
      country: 'US',
      frequency: 'weekly',
      dispatch_hour: 16,
      dispatch_minute: 0,
      dispatch_weekday: 0,
      dispatch_day: null,
      email: 'jrway123@gmail.com',
      enabled: true,
      ai_model: null,
      created_at: '2026-11-04T00:00:00+08:00',
      updated_at: '2026-11-17T14:50:00+08:00',
    },
    {
      id: 3,
      user_id: null,
      user_account_id: null,
      project_ids: '*',
      country: 'US,DE,UK,JP',
      frequency: 'monthly',
      dispatch_hour: 15,
      dispatch_minute: 0,
      dispatch_weekday: null,
      dispatch_day: 4,
      email: 'ops@company.example',
      enabled: false,
      ai_model: 'DeepSeek-V4-Pro',
      created_at: '2026-09-01T00:00:00+08:00',
      updated_at: '2026-11-17T14:50:00+08:00',
    },
  ],
}

const LEDGER_ITEMS = [
  {
    id: 1,
    ledger_key: '1:2026-11-13',
    expected_date: '2026-11-13',
    expected_at: '2026-11-13T15:10:00+08:00',
    frequency: 'daily',
    subscription_id: 1,
    email: null,
    project_ids: '1',
    project_names: ['believeboy'],
    country: 'US,DE',
    status: 'sent',
    latest_delivery_log_id: 2294,
    error_message: null,
    sent_at: null,
    email_sent: false,
    can_resend: true,
    last_checked_at: '2026-11-18T10:00:00+08:00',
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'pending',
    ai_summary_error: null,
    ai_summary_model: null,
    insight_run_id: null,
    ai_summary_updated_at: null,
  },
  {
    id: 2,
    ledger_key: '2:2026-11-13',
    expected_date: '2026-11-13',
    expected_at: '2026-11-13T16:00:00+08:00',
    frequency: 'weekly',
    subscription_id: 2,
    email: 'jrway123@gmail.com',
    project_ids: '2',
    project_names: ['car&smo-卡斯摩'],
    country: 'US',
    status: 'failed',
    latest_delivery_log_id: 2295,
    error_message: '发信失败：Resend 返回 422 domain is not verified',
    sent_at: '2026-11-13T16:01:00+08:00',
    email_sent: true,
    can_resend: true,
    last_checked_at: '2026-11-18T10:00:00+08:00',
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: '本期销售环比下降 12%，广告 ACOS 上升至 28%。',
    ai_summary_status: 'failed',
    ai_summary_error: 'AI provider timeout',
    ai_summary_model: 'DeepSeek-V4-Pro',
    insight_run_id: null,
    ai_summary_updated_at: '2026-11-13T15:22:00+08:00',
  },
  {
    id: 3,
    ledger_key: '1:2026-11-14',
    expected_date: '2026-11-14',
    expected_at: '2026-11-14T15:10:00+08:00',
    frequency: 'daily',
    subscription_id: 1,
    email: null,
    project_ids: '1',
    project_names: ['believeboy'],
    country: 'US,DE',
    status: 'missing',
    latest_delivery_log_id: null,
    error_message: null,
    sent_at: null,
    email_sent: false,
    can_resend: true,
    last_checked_at: '2026-11-18T10:00:00+08:00',
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'idle',
    ai_summary_error: null,
    ai_summary_model: null,
    insight_run_id: null,
    ai_summary_updated_at: null,
  },
]

const LEDGER = {
  items: LEDGER_ITEMS,
  summary: { expected: 3, sent: 1, failed: 1, missing: 1, resendable: 3 },
  total: 3,
}

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
    route.fulfill({ json: LEDGER })
  )
  await page.route('**/api/backend/api/v1/scheduled-reports/ledger/**', (route) =>
    route.fulfill({ json: { success: true, message: 'ok' } })
  )
  await page.route('**/api/ai-chat/config', (route) =>
    route.fulfill({
      json: {
        providerConfigured: true,
        models: ['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'],
        defaultModel: 'DeepSeek-V4-Flash',
        premiumModels: ['DeepSeek-V4-Pro'],
        basicModels: ['DeepSeek-V4-Flash'],
      },
    })
  )
  await page.route('**/api/backend/api/v1/ai/**', (route) =>
    route.fulfill({ json: { providerConfigured: false, models: [], defaultModel: null } })
  )
}

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
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

async function setTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('theme', value)
  }, theme)
}

test.use({ viewport: { width: 1440, height: 900 } })


async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
  })
  expect(overflow.scrollWidth, '页面级横向溢出').toBeLessThanOrEqual(overflow.clientWidth + 2)
}

test.describe('scheduled reports visual (plan A)', () => {
  test.beforeEach(async ({ context }) => {
    const token = await forgeSessionToken()
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
  })

  for (const theme of ['dark', 'light'] as const) {
    test(`subscriptions + edit dialog ${theme}`, async ({ page }, testInfo) => {
      await mockBackend(page)
      await setTheme(page, theme)
      await page.goto('/dashboard/reports/scheduled-reports')
      await expect(page.getByText('订阅管理').first()).toBeVisible({ timeout: 60000 })
      await expect(page.getByText('believeboy').first()).toBeVisible()
      await expectNoPageHorizontalOverflow(page)
      await expect(page.getByText('示例数据')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`subscriptions-${theme}.png`), fullPage: true })

      const editButton = page.getByRole('button', { name: '编辑订阅' }).first()
      if (await editButton.count()) {
        await editButton.click()
        await expect(page.getByText('编辑订阅').first()).toBeVisible()
        const dialog = page.locator('[data-warm-ledger-dialog="true"]').first()
        await expect(dialog).toBeVisible()
        const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(bg, '弹窗背景不能透明').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
        for (const section of ['接收', '范围', '调度', '模型']) {
          await expect(dialog.getByText(section, { exact: true }).first()).toBeVisible()
        }
        await page.screenshot({ path: testInfo.outputPath(`edit-dialog-${theme}.png`), fullPage: true })
        await page.keyboard.press('Escape')
      }

      await page.goto('/dashboard/reports/scheduled-reports/ledger')
      await expect(page.getByText('订阅记录').first()).toBeVisible({ timeout: 60000 })
      await expect(page.getByText('仅生成，不发送').first()).toBeVisible()
      await expect(page.getByText('重新生成').first()).toBeVisible()
      await expect(page.getByText('补发')).toHaveCount(0)
      await expect(page.getByText('应发').first()).toBeVisible()
      await expectNoPageHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`ledger-${theme}.png`), fullPage: true })
    })
  }
})
