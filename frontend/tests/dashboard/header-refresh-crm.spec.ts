import { expect, test } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

/**
 * BLF-1310 第一批：实际点击 TerminalHeader，使用 HTTP CRM 客户端 + 可控响应。
 * 前端自包含 fixture，不验证后端鉴权/数据库，也不连接生产。
 * 运行须 NEXT_PUBLIC_CRM_API_MODE=http；签名测试 session 复用现有 fixture。
 */
test.beforeEach(async ({ context, page }) => {
  await addBLF611FixtureAuth(context)
  await page.addInitScript(() => sessionStorage.setItem('crm-overdue-toasted', '1'))
})

function makeRow(name: string) {
  return {
    id: 1, name, title: name, rating: 'A', status: 'active', intent: 'high',
    source: 'referral', owner_id: 'u-1', owner_name: '测试负责人',
    type: 'call', priority: 'medium', created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z', entity_type: 'customer', entity_id: 1,
    next_follow_at: '2026-10-01T00:00:00Z',
  }
}

for (const route of ['customers', 'leads', 'sea', 'follow-ups'] as const) {
  test(`${route}：Head 重新请求主数据并保留查询`, async ({ page }) => {
    const endpoint = route === 'sea' ? 'customers' : route
    const urls: string[] = []
    let refreshed = false
    await page.route('**/api/backend/**', async (request) => {
      const url = new URL(request.request().url())
      if (url.pathname === `/api/backend/v1/crm/${endpoint}`) {
        urls.push(url.search)
        const row = makeRow(refreshed ? '刷新后记录' : '原有记录')
        if (route === 'follow-ups') {
          return request.fulfill({ json: {
            overdue: [row], today: [], this_week: [], overdue_count: 1, total_count: 1,
          } })
        }
        return request.fulfill({ json: { items: [row], total: 60, page: 2, page_size: 20 } })
      }
      if (url.pathname.endsWith('/users')) return request.fulfill({ json: [] })
      if (url.pathname.endsWith('/stream')) {
        return request.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
      }
      return request.fulfill({ json: { items: [], unread_count: 0 } })
    })
    const query = route === 'follow-ups' ? '' : '?page=2&keyword=记录&sortBy=name&sortOrder=desc'
    await page.goto(`/dashboard/crm/${route}${query}`)
    await expect(page).toHaveURL(new RegExp(`/dashboard/crm/${route}`))
    await expect(page.getByText('原有记录', { exact: true })).toBeVisible({ timeout: 30000 })
    const refresh = page.getByTestId('terminal-header-refresh')
    await expect(refresh).toBeEnabled()
    const before = urls.length
    const lastQuery = urls.at(-1)
    refreshed = true
    await refresh.click()
    await expect(page.getByText('刷新后记录', { exact: true })).toBeVisible()
    expect(urls.length).toBe(before + 1)
    expect(urls.at(-1)).toBe(lastQuery)
    await expect(refresh).toBeEnabled()
    if (route !== 'follow-ups') await expect(page.getByText('第 2 / 3 页')).toBeVisible()
  })
}

test('任务：Head 等待主请求、保留筛选/视图，失败保留旧记录且可以重试', async ({ page }) => {
  let taskRequests = 0
  let latestQuery = ''
  let version = 0
  let failNext = false
  let releaseResponse: (() => void) | null = null
  let pending: Promise<void> | null = null
  await page.route('**/api/backend/**', async (request) => {
    const url = new URL(request.request().url())
    if (url.pathname === '/api/backend/v1/crm/tasks') {
      taskRequests += 1
      latestQuery = url.search
      if (pending) await pending
      if (failNext) {
        failNext = false
        return request.fulfill({ status: 503, json: { detail: '测试网络失败' } })
      }
      const row = { ...makeRow(version === 0 ? '原有任务' : '更新任务'), status: 'pending' }
      return request.fulfill({ json: { items: [row], total: 1, page: 1, page_size: 100 } })
    }
    if (url.pathname.endsWith('/users')) return request.fulfill({ json: [] })
    if (url.pathname.endsWith('/stream')) {
      return request.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    }
    return request.fulfill({ json: { items: [], unread_count: 0 } })
  })
  await page.goto('/dashboard/crm/tasks')
  await expect(page).toHaveURL(/\/dashboard\/crm\/tasks$/)
  await expect(page.getByText('原有任务', { exact: true })).toBeVisible({ timeout: 30000 })
  await page.getByTestId('task-type-filter').selectOption('call')
  await page.getByTestId('view-list').click()
  await expect(page.getByTestId('terminal-header-refresh')).toBeEnabled()
  await expect.poll(() => latestQuery).toContain('type=call')

  pending = new Promise<void>((resolve) => { releaseResponse = resolve })
  const before = taskRequests
  version = 1
  const refresh = page.getByTestId('terminal-header-refresh')
  await refresh.click()
  await expect.poll(() => taskRequests).toBe(before + 1)
  await expect(refresh).toBeDisabled()
  await expect(page.getByText('原有任务', { exact: true })).toBeVisible()
  releaseResponse!()
  pending = null
  await expect(page.getByText('更新任务', { exact: true })).toBeVisible()
  await expect(refresh).toBeEnabled()
  await expect(page.getByTestId('task-type-filter')).toHaveValue('call')
  await expect(page.getByTestId('view-list')).toHaveAttribute('aria-checked', 'true')
  expect(new URLSearchParams(latestQuery).get('scope')).toBe('all')

  failNext = true
  await refresh.click()
  await expect(page.getByRole('alert')).toContainText('测试网络失败')
  await expect(page.getByText('更新任务', { exact: true })).toBeVisible()
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(refresh).toBeEnabled()
})
