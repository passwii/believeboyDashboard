/**
 * BLF-1027 · dashboard/agent-center/overview 「业务域活动矩阵」版式回归
 * —— 固定布局列宽（ColGroup）、行高一致、数字列右对齐、窄屏容器内横滑。
 * 自包含：伪造 session cookie + page.route mock 全部后端请求，无需真实后端。
 *
 * Run: PLAYWRIGHT_PORT=<port> pnpm test:ui tests/design/agent-overview-table-blf1027.spec.ts --project=chromium
 * 截图输出：frontend/test-results/blf1027/*.png
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

const OUT_DIR = path.join(__dirname, '../../test-results/blf1027')

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', operatorNameZh: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      operatorNameZh: 'E2E',
      sessionId: 'blf1027',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

const DOMAIN_SUMMARY = {
  generated_at: '2026-09-11T09:00:00Z',
  items: [
    { domain: 'complaint_center', calls_24h: 42, calls_7d: 318, writes_24h: 3, writes_7d: 21, errors_7d: 0, last_active_at: '2026-09-11T08:41:00Z' },
    { domain: 'platform_inspection', calls_24h: 118, calls_7d: 804, writes_24h: 12, writes_7d: 96, errors_7d: 4, last_active_at: '2026-09-11T08:55:00Z' },
    { domain: 'account_health', calls_24h: 96, calls_7d: 611, writes_24h: 0, writes_7d: 0, errors_7d: 2, last_active_at: '2026-09-11T07:12:00Z' },
    { domain: 'report_upload_status', calls_24h: 24, calls_7d: 168, writes_24h: 0, writes_7d: 0, errors_7d: 1, last_active_at: '2026-09-10T22:03:00Z' },
    { domain: 'shipments', calls_24h: 210, calls_7d: 2894, writes_24h: 18, writes_7d: 143, errors_7d: 12, last_active_at: '2026-09-11T09:31:00Z' },
    { domain: 'shop_calculations', calls_24h: 63, calls_7d: 402, writes_24h: 5, writes_7d: 33, errors_7d: 0, last_active_at: '2026-09-11T06:20:00Z' },
    { domain: 'return_analysis', calls_24h: 51, calls_7d: 366, writes_24h: 0, writes_7d: 0, errors_7d: 7, last_active_at: '2026-09-11T05:44:00Z' },
    { domain: 'inventory', calls_24h: 33, calls_7d: 214, writes_24h: 0, writes_7d: 0, errors_7d: 0, last_active_at: '2026-09-11T04:02:00Z' },
    { domain: 'ad_analysis', calls_24h: 187, calls_7d: 1560, writes_24h: 0, writes_7d: 0, errors_7d: 9, last_active_at: '2026-09-11T09:12:00Z' },
    { domain: 'inventory_ledger', calls_24h: 44, calls_7d: 289, writes_24h: 2, writes_7d: 17, errors_7d: 0, last_active_at: '2026-09-10T18:30:00Z' },
    { domain: 'report_upload', calls_24h: 19, calls_7d: 133, writes_24h: 19, writes_7d: 133, errors_7d: 3, last_active_at: '2026-09-11T08:02:00Z' },
    { domain: 'replenishment_analysis', calls_24h: 28, calls_7d: 187, writes_24h: 1, writes_7d: 6, errors_7d: 0, last_active_at: '2026-09-11T03:15:00Z' },
    { domain: 'new_product_calculations', calls_24h: 12, calls_7d: 88, writes_24h: 2, writes_7d: 11, errors_7d: 0, last_active_at: '2026-09-10T21:40:00Z' },
    { domain: 'sales', calls_24h: 76, calls_7d: 508, writes_24h: 0, writes_7d: 0, errors_7d: 5, last_active_at: '2026-09-11T07:58:00Z' },
    { domain: 'sku_info', calls_24h: 65, calls_7d: 477, writes_24h: 4, writes_7d: 29, errors_7d: 1, last_active_at: '2026-09-11T08:44:00Z' },
    { domain: 'agent_provisioning', calls_24h: 2, calls_7d: 9, writes_24h: 1, writes_7d: 4, errors_7d: 0, last_active_at: '2026-09-09T11:20:00Z' },
  ],
}

async function mockBackend(page: Page, opts: { summary: boolean } = { summary: true }) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/agent-ops/domain-summary**', (route) =>
    opts.summary ? route.fulfill({ json: DOMAIN_SUMMARY }) : route.fulfill({ status: 404, json: {} })
  )
  await page.route('**/api/backend/api/v1/complaints/overview**', (route) =>
    route.fulfill({ json: { shops: [{ shop_id: 1 }], metrics: { total_needs_reply: 7 } } })
  )
  await page.route('**/api/backend/api/v1/inspections/periods/current**', (route) =>
    route.fulfill({ json: { id: 7 } })
  )
  await page.route('**/api/backend/api/v1/inspections/periods/7/overview**', (route) =>
    route.fulfill({ json: { submitted_count: 3, total_projects: 5 } })
  )
  await page.route('**/api/backend/api/v1/rpa-reports/status**', (route) =>
    route.fulfill({ json: { items: [{ statuses: Array.from({ length: 15 }, (_, i) => ({ is_uploaded: i < 11 })) }] } })
  )
}

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
  void page
})

const TABLE = 'table'

async function waitTable(page: Page) {
  await page.goto('/dashboard/agent-center/overview')
  await expect(page.locator(TABLE).first()).toBeVisible({ timeout: 60000 })
  await expect(page.getByRole('heading', { level: 2, name: '业务域活动矩阵' })).toBeVisible()
}

/** 每行单元格 x 坐标必须与表头逐列一致（列不错位） */
async function columnDrift(page: Page) {
  return page.locator(TABLE).first().evaluate((table) => {
    const headCells = Array.from(table.querySelectorAll('thead tr:last-child > *'))
    const headX = headCells.map((c) => Math.round(c.getBoundingClientRect().left))
    const rows = Array.from(table.querySelectorAll('tbody tr'))
    return rows.map((row) => {
      const cells = Array.from(row.children)
      return cells.map((c, i) => Math.abs(Math.round(c.getBoundingClientRect().left) - headX[i]))
    })
  })
}

test.describe('BLF-1027 业务域活动矩阵版式', () => {
  test('桌面 1440：列对齐 / 行高一致 / 数据列右对齐', async ({ page }) => {
    await mockBackend(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await waitTable(page)
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-1440-data.png'), fullPage: true })
    await page.locator(TABLE).first().screenshot({ path: path.join(OUT_DIR, 'desktop-table-data.png') })

    // ① 列不错位：每行每个单元格左边界与表头同列偏差 ≤ 1px
    const drift = await columnDrift(page)
    const worst = Math.max(...drift.flat())
    expect(worst, `列错位最大偏差 ${worst}px`).toBeLessThanOrEqual(1)

    // ② 行高一致（无因换行造成的行高抖动）
    const rowsInfo = await page.locator(`${TABLE} tbody tr`).evaluateAll((rows) =>
      rows.map((r) => ({
        label: (r.children[0].textContent || '').trim(),
        h: Math.round(r.getBoundingClientRect().height),
        lines: Array.from(r.children).map((c) => Math.round(c.getBoundingClientRect().height)),
      }))
    )
    const heights = rowsInfo.map((r) => r.h)
    expect(
      Math.max(...heights) - Math.min(...heights),
      `行高区间 ${JSON.stringify(rowsInfo.filter((r) => r.h !== heights[0]))}`
    ).toBeLessThanOrEqual(1)

    // ③ 表格无右侧留白浪费：所有列宽之和 ≈ 容器可视宽度（不出现大片死区）
    const metrics = await page.locator(TABLE).first().evaluate((table) => {
      const wrapper = table.closest('[class*="overflow"]') as HTMLElement
      const last = table.querySelector('tbody tr:last-child > *:last-child') as HTMLElement
      const first = table.querySelector('thead tr:last-child > *:first-child') as HTMLElement
      return {
        tableWidth: Math.round(table.getBoundingClientRect().width),
        wrapperWidth: wrapper.clientWidth,
        headRight: Math.round(first.getBoundingClientRect().left),
        cellRight: Math.round(last.getBoundingClientRect().right),
      }
    })
    expect(metrics.tableWidth).toBeGreaterThanOrEqual(metrics.wrapperWidth - 1)
    // 末列右边界贴住容器右边界（无尾部空白）
    expect(metrics.wrapperWidth - (metrics.cellRight - metrics.headRight)).toBeLessThanOrEqual(1)

    // ④ 页面无整体横向滚动
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(2)
  })

  test('桌面 1440 暗色：截图 + 无浅色带', async ({ page }) => {
    await mockBackend(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
    await waitTable(page)
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-1440-dark.png'), fullPage: true })

    const bg = await page
      .locator(`${TABLE} thead th`)
      .first()
      .evaluate((el) => window.getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('运行时端点缺位：占位符列同样对齐', async ({ page }) => {
    await mockBackend(page, { summary: false })
    await page.setViewportSize({ width: 1440, height: 900 })
    await waitTable(page)
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-1440-empty.png'), fullPage: true })
    const drift = await columnDrift(page)
    expect(Math.max(...drift.flat())).toBeLessThanOrEqual(1)
  })

  test('窄屏 393：容器内横滑，页面无整体横向滚动', async ({ page }) => {
    await mockBackend(page)
    await page.setViewportSize({ width: 393, height: 851 })
    await waitTable(page)
    await page.screenshot({ path: path.join(OUT_DIR, 'mobile-393.png'), fullPage: true })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, '页面级不应出现横向滚动').toBeLessThanOrEqual(2)
    const scrollable = await page.locator(TABLE).first().evaluate((table) => {
      const wrapper = table.closest('[class*="overflow"]') as HTMLElement
      return wrapper.scrollWidth > wrapper.clientWidth
    })
    expect(scrollable, '表格容器应承接横滑').toBe(true)
  })
})
