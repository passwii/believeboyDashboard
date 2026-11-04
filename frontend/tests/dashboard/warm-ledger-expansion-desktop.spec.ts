import { expect, test, type Page } from '@playwright/test'

import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

const VIEWPORT = { width: 1440, height: 900 } as const
const STAGE_INSET = 8

const WARM_ROUTES = [
  '/dashboard/finance/platform-revenue',
  '/dashboard/finance/exchange-rate',
  '/dashboard/finance/vat-invoice',
  '/dashboard/finance/commission-management',
  '/dashboard/crm/dashboard',
  '/dashboard/crm/follow-ups',
  '/dashboard/crm/customers',
  '/dashboard/crm/sea',
  '/dashboard/crm/proposals',
  '/dashboard/crm/proposals/42',
  '/dashboard/crm/leads',
  '/dashboard/crm/tasks',
  '/dashboard/crm/audit',
  '/dashboard/crm/settings',
  '/dashboard/ai/insights',
  '/dashboard/ai/ad-analysis',
  '/dashboard/ai/inventory-health',
  '/dashboard/ai/believeboy-models',
  '/dashboard/ai/customer-service',
  '/dashboard/ai/digital-employees',
  '/dashboard/ai/digital-employees/employee-7',
  '/dashboard/ai/digital-employees/office',
  '/dashboard/tools/markdown-to-word',
  '/dashboard/tools/page-render',
  '/dashboard/tools/brand-registration-example',
  '/dashboard/tools/product-label',
  '/dashboard/tools/cross-border-compliance',
  '/dashboard/system/account-management',
  '/dashboard/system/agent-management',
  '/dashboard/system/alerts',
  '/dashboard/system/changelog',
  '/dashboard/system/data-management',
  '/dashboard/system/logs',
  '/dashboard/system/operator-management',
  '/dashboard/system/project-info',
] as const

const PROJECTS = [
  { id: 1, name: 'V4 Fixture Store' },
  { id: 2, name: 'V4 Second Store' },
]

function genericApiPayload(pathname: string) {
  const normalizedPath = pathname.replace(/\/+$/, '')
  if (normalizedPath.endsWith('/projects/manage')) return PROJECTS
  if (normalizedPath.endsWith('/internal/api-keys')) return []
  if (normalizedPath.endsWith('/digital-employees/7')) {
    return {
      id: 7,
      name: 'Fixture Employee',
      employee_type: 'PRODUCT_ANALYST',
      status: 'IDLE',
      last_heartbeat_at: '2026-11-05T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-05T00:00:00Z',
    }
  }
  if (
    normalizedPath.endsWith('/digital-employees/7/tasks') ||
    normalizedPath.endsWith('/digital-employees/7/recent-logs')
  ) {
    return { items: [], total: 0 }
  }
  if (normalizedPath.includes('/ai-chat/config')) {
    return {
      providerConfigured: false,
      models: [],
      defaultModel: '',
      premiumModels: [],
      basicModels: [],
    }
  }
  if (
    normalizedPath.includes('/exchange-rates') &&
    normalizedPath.startsWith('/api/exchange-rates')
  ) {
    return {
      success: true,
      data: [],
      pagination: { page: 1, pageSize: 12, total: 0, totalPages: 0 },
    }
  }
  if (normalizedPath.includes('/vat-invoices')) return []
  if (normalizedPath.includes('/notifications')) {
    return { items: [], unread_count: 0, unreadCount: 0 }
  }
  return {
    items: [],
    data: [],
    rows: [],
    total: 0,
    page: 1,
    pageSize: 20,
    page_size: 20,
    totalPages: 0,
    total_pages: 0,
    unread_count: 0,
  }
}

async function installApiFixtures(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(genericApiPayload(url.pathname)),
    })
  })
}

async function expectDesktopWindowGeometry(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const element = document.querySelector<HTMLElement>('.warm-ledger__app-window')
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          left: rect.left,
          top: rect.top,
          right: window.innerWidth - rect.right,
          bottom: window.innerHeight - rect.bottom,
          width: rect.width,
          height: rect.height,
          borderRadius: getComputedStyle(element).borderRadius,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
        }
      })
    )
    .toMatchObject({
      viewportWidth: VIEWPORT.width,
      viewportHeight: VIEWPORT.height,
      left: STAGE_INSET,
      top: STAGE_INSET,
      right: STAGE_INSET,
      bottom: STAGE_INSET,
      width: VIEWPORT.width - STAGE_INSET * 2,
      height: VIEWPORT.height - STAGE_INSET * 2,
      borderRadius: '22px',
    })

  const widths = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(widths.documentWidth).toBeLessThanOrEqual(VIEWPORT.width)
  expect(widths.bodyWidth).toBeLessThanOrEqual(VIEWPORT.width)
}

test.describe('V4 Warm Ledger desktop expansion matrix', () => {
  test('all C5-C7 routes keep the compact desktop canvas', async ({ page, context }) => {
    test.setTimeout(360_000)
    await page.setViewportSize(VIEWPORT)
    await addBLF611FixtureAuth(context)
    await installApiFixtures(page)

    for (const route of WARM_ROUTES) {
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
      expect(response?.ok(), `${route} should return a successful document`).toBe(true)
      await expect(page.locator('.warm-ledger__app-window'), `${route} shell`).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.locator('.warm-ledger__topbar--route'), `${route} topbar`).toBeVisible()
      await expectDesktopWindowGeometry(page)
    }
  })
})
