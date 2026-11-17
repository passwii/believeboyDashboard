import path from 'node:path'
import { mkdirSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const OUT_DIR = path.join(__dirname, '../../artifacts/blf-1568')

const PROJECTS = [{ id: 1, name: '玥涵' }]
const SUMMARY_ROWS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${String(10 + index).padStart(2, '0')}`,
  order_qty: 98 + index * 4,
  sales_amount: 8200 + index * 420,
  impressions: 18200 + index * 300,
  clicks: 1085 + index * 25,
  cpc: 0.8,
  ad_spend: 868 + index * 12,
  ad_orders: 77 + index * 2,
  available_qty: 905 - index * 3,
  page_views: 6272 + index * 300,
  units_ordered: 119 + index * 5,
  sessions: 5110 + index * 240,
  ordered_sales_amount: 7800 + index * 400,
  conversion_rate: 0.019,
  pending_order_qty: 2,
}))
const DETAIL_ROWS = Array.from({ length: 6 }, (_, index) => ({
  ...SUMMARY_ROWS[index],
  sku: `YH-${String(index + 1).padStart(3, '0')}`,
  asin: `B0${String(1000 + index).padStart(7, '0')}`,
  in_transit_qty: 50 + index * 10,
}))
const DAILY = {
  console: {
    project_id: 1,
    project_name: '玥涵',
    country: 'US',
    start_date: '2026-11-10',
    end_date: '2026-11-16',
    requested_days: 7,
    summary_days: 7,
    detail_rows: 6,
    sales_source_days: 7,
    ad_source_days: 7,
    inventory_source_days: 7,
    missing_dates: [],
    latest_sales_date: '2026-11-16',
    latest_ad_date: '2026-11-16',
    latest_inventory_date: '2026-11-16',
    business_source_days: 7,
    latest_business_date: '2026-11-16',
  },
  summary_rows: SUMMARY_ROWS,
  detail_rows: DETAIL_ROWS,
  available_dates: { '2026-11': '2026-11-10' },
}
const ALL = {
  summary_rows: SUMMARY_ROWS,
  detail_rows: DETAIL_ROWS,
  available_dates: DAILY.available_dates,
  project_breakdown: { 1: { project_name: '玥涵', summary_rows: SUMMARY_ROWS, detail_rows: DETAIL_ROWS } },
}
const ALL_COUNTRIES = {
  ...ALL,
  console: DAILY.console,
  country_breakdown: {
    US: { summary_rows: SUMMARY_ROWS, detail_rows: DETAIL_ROWS, currency: 'USD', source_currency: 'USD' },
  },
  currency: 'USD',
  currency_note: null,
}

async function prepare(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: { id: '1', name: 'E2E', fullName: '手机端测试', email: 'e2e@example.com', roleType: 'admin' },
      },
    })
  )
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) => route.fulfill({ json: PROJECTS }))
  await page.route('**/api/backend/api/v1/daily-analysis/all-projects-countries**', (route) =>
    route.fulfill({ json: ALL_COUNTRIES })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all-countries**', (route) =>
    route.fulfill({ json: ALL_COUNTRIES })
  )
  await page.route('**/api/backend/api/v1/daily-analysis/all**', (route) => route.fulfill({ json: ALL }))
  await page.route('**/api/backend/api/v1/daily-analysis**', (route) => route.fulfill({ json: DAILY }))
  await page.route('**/api/backend/api/v1/project-goals/progress**', (route) =>
    route.fulfill({
      json: {
        target_amount: 0,
        achieved_amount: 0,
        completion_vs_monthly: 0,
        completion_vs_daily: 0,
        today_day: 1,
        days_in_month: 30,
        currency: 'USD',
      },
    })
  )
  await addBLF611FixtureAuth(page.context())
}

test.describe('@blf-1568 daily-analysis 手机布局', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '手机布局回归只在 mobile project 运行')
  })

  test('390px：单行 52px 顶栏，4px 轨道，筛选条滚动收起，指标带与图表同宽', async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await prepare(page)
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')
    await expect(page.locator('[data-warm-daily-analysis]')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText('销售额', { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    })
    await expect(page.getByTestId('metric-hero-strip')).toBeAttached({ timeout: 45_000 })

    const before = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }
      }
      return {
        topbar: box('.warm-ledger__topbar--route'),
        strip: box('.warm-ledger__mobile-strip'),
        hero: box('[data-metric-cell="hero"]'),
        metricsGrid: box('[data-metric-cell="grid"]'),
        chart: box('[data-warm-daily-analysis] [data-chart-card]'),
        mainScroll: box('#main-content'),
        paddingLeft: getComputedStyle(document.querySelector('#main-content')!).paddingLeft,
        topbarRows: getComputedStyle(document.querySelector('.warm-ledger__topbar--route')!).gridTemplateRows,
        stripPosition: getComputedStyle(document.querySelector('.warm-ledger__mobile-strip')!).position,
        filterButtonVisible: Boolean(document.querySelector('[aria-label="打开页面筛选"]')),
      }
    })

    expect(before.topbar?.height).toBeLessThanOrEqual(53)
    expect(before.topbar?.height).toBeGreaterThanOrEqual(52)
    expect(before.topbarRows).toMatch(/^52px/)
    expect(before.paddingLeft).toBe('4px')
    expect(before.stripPosition).not.toBe('sticky')
    expect(before.filterButtonVisible).toBe(true)
    expect(before.hero?.left).toBeLessThanOrEqual(5)
    expect(before.chart?.left).not.toBeUndefined()
    expect(before.chart?.left).toBeLessThanOrEqual(5)
    expect(Math.abs((before.hero?.width ?? 0) * 2 + 8 - (before.chart?.width ?? 0))).toBeLessThanOrEqual(10)
    // Desktop grid exists but is hidden on phone; phone-specific hero/strip must render.
    expect(before.metricsGrid).not.toBeNull()

    // The filter summary should collapse entirely after a short scroll.
    await page.evaluate(() => {
      const main = document.querySelector('#main-content')
      if (main) main.scrollTop = 56
    })
    await page.waitForTimeout(150)
    const afterScroll = await page.evaluate(() => {
      const strip = document.querySelector('.warm-ledger__mobile-strip') as HTMLElement | null
      const trigger = strip?.querySelector('button') as HTMLElement | null
      const hero = document.querySelector('[data-metric-cell="hero"]') as HTMLElement | null
      return {
        stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null,
        triggerHeight: trigger ? Math.round(trigger.getBoundingClientRect().height) : null,
        heroTop: hero ? Math.round(hero.getBoundingClientRect().top) : null,
      }
    })
    expect(afterScroll.stripHeight).toBeLessThanOrEqual(2)
    expect(afterScroll.triggerHeight).toBe(0)
    await page.screenshot({ path: path.join(OUT_DIR, 'after-390-implemented.png') })

    // The topbar filter entry reopens the strip; it must become visible again.
    await page.getByRole('button', { name: '打开页面筛选' }).click()
    await expect(page.getByTestId('mobile-filter-strip-grid')).toBeVisible()
  })

  test('390px：筛选条滚回顶部时可重新展开', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepare(page)
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')
    await expect(page.locator('[data-warm-daily-analysis]')).toBeVisible({ timeout: 45_000 })
    await page.evaluate(() => {
      const main = document.querySelector('#main-content')
      if (main) main.scrollTop = 0
    })
    await expect(page.getByRole('button', { name: '切换页面筛选' })).toBeVisible()
    await page.getByRole('button', { name: '切换页面筛选' }).click()
    await expect(page.getByTestId('mobile-filter-strip-grid')).toBeVisible()
    await page.getByRole('button', { name: '切换页面筛选' }).click()
    await expect(page.getByTestId('mobile-filter-strip-grid')).not.toBeVisible()
  })

})

test.describe('@blf-1568 desktop 零回归', () => {
  test('1440px：桌面仍使用原网格指标区，手机指标带隐藏', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await prepare(page)
    await page.goto('/dashboard/operations/daily-analysis?project=1&country=US')
    await expect(page.locator('[data-warm-daily-analysis]')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('metric-hero-strip')).not.toBeVisible()
  })
})
