/**
 * Discovery Crawler — 全页面体检（BEL-379 扩展）
 *
 * 遍历 dashboard 全部 78 个页面，真登录 + 采集 console/network errors +
 * 加载耗时 + 截图，生成结构化报告（markdown + json）。
 *
 * 这就是测试工程师拿到陌生系统时第一步干的事：不写 functional test，
 * 先跑一遍"页面能不能打开、有没有报错、接口有没有 4xx/5xx、加载快不快"。
 * 报告里的 ❌/⚠️ 列表 = 后续写 functional test 的优先级输入。
 *
 * Run:
 *   pnpm test:ui -- tests/crawl/discovery.spec.ts --project=chromium
 *
 * Report output:
 *   frontend/test-results/crawl-report.md   (human-readable)
 *   frontend/test-results/crawl-report.json (programmatic)
 *   frontend/test-results/crawl/*.png       (screenshots)
 *
 * Required env (in backend/.env.test, gitignored):
 *   TEST_USER_EMAIL, TEST_USER_PASSWORD
 */
import { test, type Page } from '@playwright/test'

// ── Route list (generated from `find app/dashboard -name page.tsx`) ────────
// Dynamic params ([id], [conversationId]) resolved to placeholder "1".
const ROUTES: string[] = [
  '/dashboard',
  '/dashboard/advertising/ad-analysis',
  '/dashboard/advertising/ad-analysis/budget',
  '/dashboard/advertising/ad-analysis/campaigns',
  '/dashboard/advertising/ad-analysis/overview',
  '/dashboard/advertising/ad-analysis/placements',
  '/dashboard/advertising/ad-analysis/products',
  '/dashboard/advertising/ad-analysis/purchased-products',
  '/dashboard/advertising/ad-analysis/search-terms',
  '/dashboard/advertising/ad-analysis/targets',
  '/dashboard/advertising/ad-analysis/time-trend',
  '/dashboard/advertising/ad-analysis/traffic-quality',
  '/dashboard/advertising/ad-data',
  '/dashboard/ai',
  '/dashboard/ai/ad-analysis',
  '/dashboard/ai/believeboy-models',
  '/dashboard/ai/chat',
  '/dashboard/ai/customer-service',
  '/dashboard/ai/digital-employees',
  '/dashboard/ai/digital-employees/1',
  '/dashboard/ai/digital-employees/office',
  '/dashboard/ai/insights',
  '/dashboard/change-password',
  '/dashboard/crm',
  '/dashboard/crm/audit',
  '/dashboard/crm/customers',
  '/dashboard/crm/dashboard',
  '/dashboard/crm/follow-ups',
  '/dashboard/crm/leads',
  '/dashboard/crm/sea',
  '/dashboard/crm/settings',
  '/dashboard/crm/workbench',
  '/dashboard/feature-updates',
  '/dashboard/finance/commission-management',
  '/dashboard/finance/exchange-rate',
  '/dashboard/finance/platform-revenue',
  '/dashboard/finance/vat-invoice',
  '/dashboard/finance/vat-invoices',
  '/dashboard/operations/daily-analysis',
  '/dashboard/operations/inventory-analysis',
  '/dashboard/operations/platform-inspection',
  '/dashboard/operations/project-goals',
  '/dashboard/operations/research-analysis',
  '/dashboard/operations/return-analysis',
  '/dashboard/operations/site-navigation',
  '/dashboard/operations/store-navigation',
  '/dashboard/profile',
  '/dashboard/reports/auto-upload',
  '/dashboard/reports/financial-data',
  '/dashboard/reports/monthly-report',
  '/dashboard/reports/order-info',
  '/dashboard/reports/pricing-calculation',
  '/dashboard/reports/pricing-calculation/new-product',
  '/dashboard/reports/pricing-calculation/shop-calculation',
  '/dashboard/reports/product-analysis',
  '/dashboard/reports/report-reconciliation',
  '/dashboard/reports/scheduled-reports',
  '/dashboard/reports/scheduled-reports/ledger',
  '/dashboard/reports/scheduled-reports/subscriptions',
  '/dashboard/supply-chain/inventory-ledger',
  '/dashboard/supply-chain/inventory-replenishment',
  '/dashboard/supply-chain/portfolio-overview',
  '/dashboard/supply-chain/seasonal-replenishment',
  '/dashboard/supply-chain/shipment-management',
  '/dashboard/supply-chain/sku-info',
  '/dashboard/supply-chain/weekly-product-analysis',
  '/dashboard/system/account-management',
  '/dashboard/system/alerts',
  '/dashboard/system/backup-management',
  '/dashboard/system/changelog',
  '/dashboard/system/data-management',
  '/dashboard/system/digital-display',
  '/dashboard/system/logs',
  '/dashboard/system/operator-management',
  '/dashboard/system/project-info',
  '/dashboard/table-showcase',
  '/dashboard/tools/markdown-to-word',
  '/dashboard/tools/page-render',
]

// ── Auth (inline, mirrors backend/scripts/agent_testing/auth.py) ───────────
const AUTH_FILE = 'tests/.auth/user.json'
const REFRESH = process.env.E2E_REFRESH_AUTH === '1'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3200'

async function loginAsUser(page: Page): Promise<void> {
  const email = process.env.TEST_USER_EMAIL
  const password = process.env.TEST_USER_PASSWORD
  if (!email || !password) {
    throw new Error(
      'loginAsUser requires TEST_USER_EMAIL and TEST_USER_PASSWORD ' +
        '(set in backend/.env.test — gitignored, never committed).'
    )
  }
  const context = page.context()
  if (!REFRESH) {
    try {
      const fs = await import('node:fs')
      if (fs.existsSync(AUTH_FILE)) {
        const cached = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
        if (cached.cookies) await context.addCookies(cached.cookies)
        const session = await context.request.get(`${BASE_URL}/api/auth/session`)
        const data = (await session.json()) as { user?: { id?: string | number } }
        if (data?.user?.id) return
      }
    } catch { /* fall through */ }
  }
  const csrfResp = await context.request.get(`${BASE_URL}/api/auth/csrf`)
  const csrfToken = ((await csrfResp.json()) as { csrfToken?: string }).csrfToken
  if (!csrfToken) throw new Error(`NextAuth CSRF fetch failed: ${csrfResp.status()}`)
  const resp = await context.request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    form: { csrfToken, email, password, json: 'true' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  })
  if (resp.status() !== 200 && resp.status() !== 302) {
    throw new Error(`NextAuth login failed: ${resp.status()} ${(await resp.text()).slice(0, 200)}`)
  }
  try {
    const fs = await import('node:fs')
    fs.mkdirSync('tests/.auth', { recursive: true })
    fs.writeFileSync(AUTH_FILE, JSON.stringify(await context.storageState()), 'utf-8')
  } catch { /* best-effort */ }
}

// ── Crawl result types ─────────────────────────────────────────────────────
interface PageResult {
  route: string
  status: 'pass' | 'warn' | 'fail'
  loadTimeMs: number
  consoleErrors: string[]
  consoleWarnings: string[]
  pageErrors: string[]
  networkErrors: Array<{ url: string; status: number }>
  screenshotPath: string
  notes: string[]
}

const results: PageResult[] = []

// ── Test suite ─────────────────────────────────────────────────────────────
test.describe('Discovery Crawler — 全页面体检', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    await loginAsUser(page)
    await page.close()
  })

  for (const route of ROUTES) {
    const testName = route.replace('/dashboard/', '').replace(/\//g, ' › ') || 'dashboard home'
    test(testName, async ({ page }) => {
      const consoleErrors: string[] = []
      const consoleWarnings: string[] = []
      const pageErrors: string[] = []
      const networkErrors: Array<{ url: string; status: number }> = []
      const notes: string[] = []

      // Capture console + page errors
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
        if (msg.type() === 'warning') consoleWarnings.push(msg.text().slice(0, 200))
      })
      page.on('pageerror', (err) => {
        pageErrors.push(err.message.slice(0, 300))
      })
      // Capture network 4xx/5xx (exclude known-benign: favicon, analytics)
      page.on('response', (resp) => {
        const s = resp.status()
        if (s >= 400) {
          const url = resp.url()
          if (!url.includes('favicon') && !url.includes('analytics') && !url.includes('/_next/')) {
            networkErrors.push({ url: url.replace(BASE_URL, ''), status: s })
          }
        }
      })

      // Navigate
      const start = Date.now()
      let navigationOk = true
      try {
        await page.goto(route, { waitUntil: 'networkidle', timeout: 30000 })
      } catch (err) {
        navigationOk = false
        notes.push(`Navigation timeout/error: ${(err as Error).message.slice(0, 150)}`)
      }
      const loadTimeMs = Date.now() - start

      // Check for blank page / error overlay
      if (navigationOk) {
        const bodyText = await page.locator('body').innerText().catch(() => '')
        if (bodyText.trim().length < 10) {
          notes.push('Page appears blank (< 10 chars of text)')
        }
        // Next.js error overlay
        const errorOverlay = page.locator('nextjs-portal, [data-nextjs-dialog]')
        if (await errorOverlay.count() > 0) {
          notes.push('Next.js error overlay detected')
        }
      }

      // Screenshot
      const screenshotName = route.replace(/\//g, '_').replace(/^_/, '') + '.png'
      const screenshotPath = `test-results/crawl/${screenshotName}`
      try {
        const fs = await import('node:fs')
        fs.mkdirSync('test-results/crawl', { recursive: true })
        await page.screenshot({ path: screenshotPath, fullPage: false })
      } catch { /* screenshot best-effort */ }

      // Determine status
      const hasErrors = consoleErrors.length > 0 || pageErrors.length > 0 || networkErrors.some(e => e.status >= 500)
      const hasWarnings = consoleWarnings.length > 0 || networkErrors.some(e => e.status >= 400 && e.status < 500) || notes.length > 0
      const status: PageResult['status'] = hasErrors ? 'fail' : hasWarnings ? 'warn' : 'pass'

      results.push({ route, status, loadTimeMs, consoleErrors, consoleWarnings, pageErrors, networkErrors, screenshotPath, notes })
    })
  }

  test.afterAll(async () => {
    // Write report
    const fs = await import('node:fs')
    fs.mkdirSync('test-results', { recursive: true })

    // JSON report
    fs.writeFileSync('test-results/crawl-report.json', JSON.stringify(results, null, 2), 'utf-8')

    // Markdown report
    const lines: string[] = [
      '# Discovery Crawler Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Pages scanned: ${results.length}`,
      '',
      '## Summary',
      '',
      `| Status | Count |`,
      `|--------|-------|`,
      `| ✅ Pass | ${results.filter(r => r.status === 'pass').length} |`,
      `| ⚠️ Warn | ${results.filter(r => r.status === 'warn').length} |`,
      `| ❌ Fail | ${results.filter(r => r.status === 'fail').length} |`,
      '',
      '## Failures (❌)',
      '',
    ]
    const failures = results.filter(r => r.status === 'fail')
    if (failures.length === 0) {
      lines.push('None! 🎉')
    } else {
      for (const r of failures) {
        lines.push(`### ${r.route}`)
        lines.push(`- Load: ${r.loadTimeMs}ms`)
        if (r.consoleErrors.length) lines.push(`- Console errors (${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 3).join(' | ')}`)
        if (r.pageErrors.length) lines.push(`- Page errors: ${r.pageErrors.slice(0, 3).join(' | ')}`)
        if (r.networkErrors.length) lines.push(`- Network errors: ${r.networkErrors.slice(0, 5).map(e => `${e.status} ${e.url}`).join(', ')}`)
        if (r.notes.length) lines.push(`- Notes: ${r.notes.join('; ')}`)
        lines.push(`- Screenshot: ${r.screenshotPath}`)
        lines.push('')
      }
    }
    lines.push('## Warnings (⚠️)', '')
    const warnings = results.filter(r => r.status === 'warn')
    if (warnings.length === 0) {
      lines.push('None.')
    } else {
      lines.push('| Page | Load | Warnings | Network 4xx | Notes |')
      lines.push('|------|------|----------|-------------|-------|')
      for (const r of warnings) {
        const warn = r.consoleWarnings.length + r.networkErrors.filter(e => e.status < 500).length
        lines.push(`| ${r.route} | ${r.loadTimeMs}ms | ${warn} | ${r.networkErrors.filter(e => e.status >= 400 && e.status < 500).length} | ${r.notes.join('; ').slice(0, 80)} |`)
      }
    }
    lines.push('', '## All pages (load time)', '')
    lines.push('| Page | Status | Load (ms) | Console Err | Network Err |')
    lines.push('|------|--------|-----------|-------------|-------------|')
    for (const r of results.sort((a, b) => b.loadTimeMs - a.loadTimeMs)) {
      const icon = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️' : '❌'
      lines.push(`| ${r.route} | ${icon} | ${r.loadTimeMs} | ${r.consoleErrors.length + r.pageErrors.length} | ${r.networkErrors.length} |`)
    }
    lines.push('')

    fs.writeFileSync('test-results/crawl-report.md', lines.join('\n'), 'utf-8')
    console.log(`\n📊 Crawl report written to test-results/crawl-report.md (${results.length} pages)`)
  })
})