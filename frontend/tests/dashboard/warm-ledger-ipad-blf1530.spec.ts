import { expect, test, type Page } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const PROJECTS = [{ id: 1, name: 'iPad 回归项目' }]
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
    1: { project_name: 'iPad 回归项目', summary_rows: SUMMARY_ROWS },
  },
}

const COUNTRIES_PAYLOAD = {
  summary_rows: SUMMARY_ROWS,
  country_breakdown: {
    US: { summary_rows: SUMMARY_ROWS },
  },
}

const IPAD_VIEWPORTS = [
  { width: 810, height: 1080, label: 'iPad 10.2 portrait' },
  { width: 820, height: 1180, label: 'iPad 10.9 portrait' },
  { width: 834, height: 1194, label: 'iPad Pro 11 portrait' },
  { width: 1024, height: 1366, label: 'iPad Pro 12.9 portrait' },
  { width: 1080, height: 810, label: 'iPad 10.2 landscape' },
  { width: 1194, height: 834, label: 'iPad Pro 11 landscape' },
  { width: 1366, height: 1024, label: 'iPad Pro 12.9 landscape' },
] as const

async function prepareDashboard(page: Page) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          id: '1',
          name: 'E2E',
          fullName: 'iPad 回归',
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

async function expectNoPageHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }))
  expect(overflow.document).toBeLessThanOrEqual(2)
  expect(overflow.body).toBeLessThanOrEqual(2)
}

for (const viewport of IPAD_VIEWPORTS) {
  test(`@ipad-blf1530 ${viewport.label} (${viewport.width}px): compact desktop rail and desktop scale`, async ({
    page,
  }) => {
    await prepareDashboard(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/dashboard')

    const appWindow = page.locator('.warm-ledger__app-window')
    const sidebar = page.locator('.warm-ledger__sidebar')
    await expect(appWindow).toBeVisible()
    await expect(sidebar).toBeVisible()

    const geometry = await page.evaluate(() => {
      const appWindowElement = document.querySelector<HTMLElement>('.warm-ledger__app-window')
      const sidebarElement = document.querySelector<HTMLElement>('.warm-ledger__sidebar')
      const appWindowRect = appWindowElement?.getBoundingClientRect()
      const sidebarRect = sidebarElement?.getBoundingClientRect()
      return {
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        appWindow: appWindowRect
          ? { x: appWindowRect.x, y: appWindowRect.y, width: appWindowRect.width }
          : null,
        sidebar: sidebarRect
          ? { x: sidebarRect.x, width: sidebarRect.width }
          : null,
      }
    })

    expect(geometry.rootFontSize, 'iPad 应与电脑端同用 16px 根字号').toBe('16px')
    expect(geometry.appWindow).not.toBeNull()
    expect(Math.abs(geometry.appWindow!.x - 8)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.appWindow!.y - 8)).toBeLessThanOrEqual(1)
    expect(geometry.sidebar).not.toBeNull()
    expect(geometry.sidebar!.x).toBeGreaterThanOrEqual(0)
    expect(geometry.sidebar!.width).toBeGreaterThanOrEqual(88)

    await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden()
    await expect(page.getByRole('navigation', { name: '移动主导航' })).toBeHidden()
    await expect(page.locator('.warm-ledger__topbar')).toHaveCSS('height', '64px')

    const refresh = page.getByRole('button', { name: '刷新当前页数据' })
    await expect(refresh).toBeVisible()
    const refreshBox = await refresh.boundingBox()
    expect(refreshBox).not.toBeNull()
    expect(refreshBox!.height).toBeGreaterThanOrEqual(44)
    expect(refreshBox!.width).toBeGreaterThanOrEqual(44)

    await expectNoPageHorizontalOverflow(page)
  })
}

test('@ipad-blf1530 767px stays on the phone drawer boundary', async ({ page }) => {
  await prepareDashboard(page)
  await page.setViewportSize({ width: 767, height: 1024 })
  await page.goto('/dashboard')

  await expect(page.locator('.warm-ledger__app-window')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '移动主导航' })).toBeHidden()

  const appWindowX = await page
    .locator('.warm-ledger__app-window')
    .evaluate((element) => element.getBoundingClientRect().x)
  expect(appWindowX).toBe(0)
  await expectNoPageHorizontalOverflow(page)
})
