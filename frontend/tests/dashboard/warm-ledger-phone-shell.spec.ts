import { expect, test } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const PROJECTS = [{ id: 1, name: '手机端测试项目' }]
const SUMMARY_ROWS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${String(index + 7).padStart(2, '0')}`,
  order_qty: 10 + index,
  sales_amount: 1000 + index * 100,
  impressions: 5000 + index * 500,
  clicks: 300 + index * 20,
  cpc: 0.5,
  ad_spend: 150 + index * 10,
  ad_orders: 8 + index,
  available_qty: 200 - index,
  page_views: 4000 + index * 400,
  units_ordered: 9 + index,
  sessions: 3800 + index * 350,
  ordered_sales_amount: 900 + index * 90,
  conversion_rate: 0.02,
  pending_order_qty: 2,
}))

const DAILY_PAYLOAD = {
  summary_rows: SUMMARY_ROWS,
  project_breakdown: {
    1: { project_name: '手机端测试项目', summary_rows: SUMMARY_ROWS },
  },
}

const COUNTRIES_PAYLOAD = {
  summary_rows: SUMMARY_ROWS,
  country_breakdown: {
    US: { summary_rows: SUMMARY_ROWS },
  },
}

async function prepareDashboard(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          id: '1',
          name: 'E2E',
          fullName: '手机端测试',
          email: 'e2e@example.com',
          roleType: 'admin',
        },
      },
    })
  )
  await page.route('**/api/backend-base**', (route) =>
    route.fulfill({ json: { base_url: '' } })
  )
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: PROJECTS })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all?**', (route) =>
    route.fulfill({ json: DAILY_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all-projects-countries**', (route) =>
    route.fulfill({ json: COUNTRIES_PAYLOAD })
  )
  await page.route('**/api/backend/api/v1/order-info/overview**', (route) =>
    route.fulfill({ json: { items: [], total: 0 } })
  )
  await page.route('**/api/backend/api/v1/order-info/live-stream**', (route) =>
    route.fulfill({ json: { items: [] } })
  )
  await addBLF611FixtureAuth(page.context())
}

async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))

  expect(widths.document, '文档不应横向溢出').toBeLessThanOrEqual(widths.viewport + 2)
  expect(widths.body, '页面不应横向溢出').toBeLessThanOrEqual(widths.viewport + 2)
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'warm-ledger-phone-shell uses explicit phone viewports'
  )
})

test.beforeEach(async ({ page }) => {
  await prepareDashboard(page)
})

test('@blf-1513 390px phone: Dock, searchable domain drawer, home actions, and daily table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/dashboard')

  const dock = page.getByRole('navigation', { name: '移动主导航' })
  await expect(dock).toBeVisible()
  await expect(dock.getByRole('link', { name: '总览' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await expect(dock.getByRole('button')).toHaveCount(4)

  const operationButton = dock.getByRole('button', { name: '运营' })
  await operationButton.click()
  const quickLinks = page.locator('.warm-ledger__mobile-quick-links a')
  await expect(quickLinks).toHaveCount(4)
  await expect(quickLinks.nth(0)).toHaveAttribute(
    'href',
    '/dashboard/operations/daily-analysis'
  )
  await expect(quickLinks.nth(1)).toHaveAttribute(
    'href',
    '/dashboard/reports/order-info'
  )

  const search = page.getByRole('searchbox', { name: '搜索页面' })
  await expect(search).toBeFocused()
  await search.fill('评论追踪')
  await expect(
    page.getByRole('link', { name: '评论追踪' })
  ).toHaveAttribute('href', '/dashboard/operations/review-tracking')
  await expect(page.getByRole('link', { name: '销售数据' })).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(operationButton).toBeFocused()
  await expect(operationButton).toHaveAttribute('aria-expanded', 'false')

  for (const label of ['刷新当前页数据', '全局搜索', '通知', '个人资料']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }
  await expect(page.getByRole('combobox', { name: '项目筛选' })).toBeVisible()
  await expect(page.getByText('US · PT 运营日')).toBeVisible()

  const dailyTable = page.getByRole('region', { name: '日明细表格' })
  await dailyTable.scrollIntoViewIfNeeded()
  await expect(dailyTable).toBeVisible()
  const tableSizes = await dailyTable.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }))
  expect(tableSizes.scroll).toBeGreaterThan(tableSizes.client)
  await expectNoPageHorizontalOverflow(page)
})

test('@blf-1513 320px phone: controls remain in bounds and every dashboard action stays reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/dashboard')

  const actionButtons = [
    page.getByRole('button', { name: '刷新当前页数据' }),
    page.getByRole('button', { name: '全局搜索' }),
    page.getByRole('button', { name: '通知' }),
    page.getByRole('button', { name: '个人资料' }),
  ]

  for (const button of actionButtons) {
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }

  const dock = page.getByRole('navigation', { name: '移动主导航' })
  await expect(dock.getByRole('button')).toHaveCount(4)
  await expectNoPageHorizontalOverflow(page)
})

test('@blf-1513 desktop retains the existing app-window geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/dashboard')

  const appWindow = page.locator('.warm-ledger__app-window')
  await expect(appWindow).toBeVisible()
  const box = await appWindow.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.x - 8)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.y - 8)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.width - 1424)).toBeLessThanOrEqual(2)
  expect(Math.abs(box!.height - 884)).toBeLessThanOrEqual(2)
  expect(await appWindow.evaluate((element) => getComputedStyle(element).gridTemplateColumns))
    .toMatch(/^280px/)
})
