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
  '/dashboard/ai/digital-employees/7',
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
  '/dashboard/reports/auto-upload',
  '/dashboard/reports/monthly-report/generate',
  '/dashboard/reports/monthly-report/reconcile',
  '/dashboard/reports/pricing-calculation',
  '/dashboard/reports/pricing-calculation/new-product',
  '/dashboard/reports/pricing-calculation/shop-calculation',
  '/dashboard/reports/report-reconciliation',
  '/dashboard/reports/scheduled-reports',
  '/dashboard/reports/scheduled-reports/ledger',
  '/dashboard/reports/scheduled-reports/subscriptions',
  '/dashboard/operations/complaint-center',
  '/dashboard/operations/complaint-center/list',
  '/dashboard/operations/inventory-replenishment',
  '/dashboard/operations/platform-inspection',
  '/dashboard/operations/project-goals',
  '/dashboard/operations/project-launch',
  '/dashboard/operations/project-launch/templates',
  '/dashboard/operations/research-analysis',
  '/dashboard/operations/return-analysis',
  '/dashboard/operations/review-tracking',
  '/dashboard/operations/seasonal-replenishment',
  '/dashboard/operations/site-navigation',
  '/dashboard/operations/store-navigation',
  '/dashboard/operations/weekly-product-analysis',
  '/dashboard/agent-center/overview',
  '/dashboard/agent-center/employees',
  '/dashboard/advertising/ad-analysis',
  '/dashboard/advertising/ad-analysis/overview',
  '/dashboard/advertising/ad-analysis/budget',
  '/dashboard/advertising/ad-analysis/campaigns',
  '/dashboard/advertising/ad-analysis/placements',
  '/dashboard/advertising/ad-analysis/products',
  '/dashboard/advertising/ad-analysis/purchased-products',
  '/dashboard/advertising/ad-analysis/search-terms',
  '/dashboard/advertising/ad-analysis/targets',
  '/dashboard/advertising/ad-analysis/time-trend',
  '/dashboard/advertising/ad-analysis/traffic-quality',
  '/dashboard/advertising/ad-data',
  '/dashboard/profile',
  '/dashboard/change-password',
  '/dashboard/feature-updates',
  '/dashboard/table-showcase',
] as const

const REDIRECT_TARGETS: Partial<Record<(typeof WARM_ROUTES)[number], string>> = {
  '/dashboard/reports/report-reconciliation': '/dashboard/reports/monthly-report/reconcile',
  '/dashboard/advertising/ad-analysis': '/dashboard/advertising/ad-analysis/overview',
}

const STANDALONE_ROUTES = [
  '/dashboard/ai',
  '/dashboard/ai/chat',
  '/dashboard/system/digital-display',
] as const

const PROJECTS = [
  {
    id: 1,
    name: 'V4 Fixture Store',
    brand_name: null,
    store_address: null,
    project_operator: null,
    assistant_operator: null,
    commission_basis: null,
    commission_rate: null,
    sort_order: 1,
    is_active: true,
    source_file: null,
    has_context: false,
    project_tier: null,
    country: 'US',
    country_name: '美国',
  },
  {
    id: 2,
    name: 'V4 Second Store',
    brand_name: null,
    store_address: null,
    project_operator: null,
    assistant_operator: null,
    commission_basis: null,
    commission_rate: null,
    sort_order: 2,
    is_active: true,
    source_file: null,
    has_context: false,
    project_tier: null,
    country: 'DE',
    country_name: '德国',
  },
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
  if (normalizedPath.includes('/complaints/overview')) {
    return {
      date: '2026-11-05',
      metrics: {
        total_needs_reply: 0,
        total_reported_unresolved: 0,
        total_resolved: 0,
        sla_due_soon: 0,
        sla_overdue: 0,
      },
      trend: [],
      projects: [],
    }
  }
  if (normalizedPath.includes('/inventory-replenishment-analysis')) {
    return {
      items: [],
      summary: {
        sku_count: 0,
        out_of_stock_risk_count: 0,
        healthy_count: 0,
        slow_moving_count: 0,
        pending_data_count: 0,
        total_available_inventory: 0,
        total_in_transit_quantity: 0,
      },
      page: 1,
      page_size: 20,
      total: 0,
      has_next: false,
    }
  }
  if (normalizedPath.includes('/seasonal-replenishment-analysis')) {
    return {
      items: [],
      summary: {
        sku_count: 0,
        out_of_stock_risk_count: 0,
        healthy_count: 0,
        slow_moving_count: 0,
        pending_data_count: 0,
        total_available_inventory: 0,
        total_in_transit_quantity: 0,
      },
      page: 1,
      page_size: 200,
      total: 0,
    }
  }
  if (normalizedPath.includes('/return-analysis')) {
    return {
      project_id: 1,
      project_name: 'V4 Fixture Store',
      country: 'US',
      start_date: '2026-10-27',
      end_date: '2026-11-02',
      summary: {
        total_returns: 0,
        total_quantity: 0,
        unique_skus: 0,
        top_return_sku: null,
        top_return_reason: null,
        top_return_reason_display: null,
        total_sales_quantity: 0,
        total_sales_amount: 0,
        overall_return_rate: 0,
      },
      summary_text: '',
      ranking_rows: [],
      reason_rows: [],
      trend_rows: [],
      disposition_rows: [],
      status_rows: [],
      feedback_rows: [],
      weekday_rows: [],
      fulfillment_center_rows: [],
      multi_item_return_count: 0,
      multi_item_return_quantity: 0,
    }
  }
  if (normalizedPath.includes('/project-goals/progress')) {
    return {
      project_id: 1,
      country: 'US',
      currency: 'USD',
      year: 2026,
      monthly_progress: [],
      annual_progress: null,
    }
  }
  if (normalizedPath.includes('/project-workflows/summary')) {
    return { projects: [] }
  }
  if (normalizedPath.includes('/product-analysis/weekly')) {
    return []
  }
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
      page
        .evaluate(() => {
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
        .catch((error: Error) => {
          if (error.message.includes('Execution context was destroyed')) return null
          throw error
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

  await expect
    .poll(async () =>
      page
        .evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
        }))
        .then(
          ({ documentWidth, bodyWidth }) =>
            documentWidth <= VIEWPORT.width && bodyWidth <= VIEWPORT.width
        )
        .catch((error: Error) => {
          if (error.message.includes('Execution context was destroyed')) return false
          throw error
        })
    )
    .toBe(true)
}

test.describe('V4 Warm Ledger desktop expansion matrix', () => {
  test('Office presentation mode bypasses the Warm app frame', async ({ page, context }) => {
    await page.setViewportSize(VIEWPORT)
    await addBLF611FixtureAuth(context)
    await installApiFixtures(page)

    const response = await page.goto(
      '/dashboard/ai/digital-employees/office?mode=presentation',
      { waitUntil: 'domcontentloaded' }
    )
    expect(response?.ok()).toBe(true)
    await expect(page.locator('[data-office-presentation="true"]')).toBeVisible()
    await expect(page.locator('.warm-ledger__app-window')).toHaveCount(0)
  })

  test('all C5-C8 routes keep the compact desktop canvas', async ({ page, context }) => {
    test.setTimeout(480_000)
    await page.setViewportSize(VIEWPORT)
    await addBLF611FixtureAuth(context)
    await installApiFixtures(page)

    for (const route of WARM_ROUTES) {
      const redirectTarget = REDIRECT_TARGETS[route]
      // Several routes normalize project/country query params during hydration.
      // Wait for the HTTP commit before that same-document replace can abort goto().
      // Redirect aliases must finish before the next matrix navigation starts.
      let response: Awaited<ReturnType<Page['goto']>> = null
      try {
        response = await page.goto(route, {
          waitUntil: redirectTarget ? 'domcontentloaded' : 'commit',
        })
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('net::ERR_ABORTED')) {
          throw error
        }
        const probe = await page.request.get(route)
        expect(probe.ok(), `${route} should return a successful document`).toBe(true)
      }
      if (redirectTarget) {
        await page.waitForURL((url) => url.pathname === redirectTarget)
      } else {
        await page.waitForURL((url) => url.pathname === route)
      }
      if (response) {
        expect(response.ok(), `${route} should return a successful document`).toBe(true)
      }
      await expect(page.locator('.warm-ledger__app-window'), `${route} shell`).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.locator('.warm-ledger__topbar--route'), `${route} topbar`).toBeVisible()
      await expectDesktopWindowGeometry(page)
    }
  })

  test('standalone Warm routes render outside the framed app window', async ({ page, context }) => {
    await page.setViewportSize(VIEWPORT)
    await addBLF611FixtureAuth(context)
    await installApiFixtures(page)

    for (const route of STANDALONE_ROUTES) {
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
      expect(response?.ok(), `${route} should return a successful document`).toBe(true)
      await expect(page.locator('.warm-ledger'), `${route} Warm surface`).toBeVisible()
      await expect(page.locator('.warm-ledger__app-window'), `${route} app window`).toHaveCount(0)
    }
  })
})
