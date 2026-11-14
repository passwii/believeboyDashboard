import { expect, test, type Locator, type Page } from '@playwright/test'

import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

/**
 * BLF-1510 Stage 7 AI workspace phone regression.
 *
 * This supersedes the pre-V4 BLF-619 AI mobile spec. All backend data is
 * mocked so the layout assertions run without a local API or AI provider.
 * The suite covers the ten AI routes plus dedicated chat and virtual-office
 * passes, compact-phone widths, and the 1440 desktop contract.
 */

const PROJECTS = [
  { id: 1, name: '北美旗舰店', brand_name: null, is_active: true },
  { id: 2, name: '欧洲增长店', brand_name: 'Believeboy EU', is_active: true },
]

const INSIGHTS = [
  {
    id: 101,
    project_id: 1,
    project_name: '北美旗舰店',
    country: 'US',
    title: '2026-11 销售洞察',
    insight_type: 'custom',
    date_range_start: '2026-11-01',
    date_range_end: '2026-11-07',
    status: 'completed',
    sub_status: null,
    created_by: 'E2E',
    created_at: '2026-11-08T08:00:00Z',
    updated_at: '2026-11-08T08:10:00Z',
    content: '# 销售洞察\n\n本期销售保持增长。',
  },
]

const EMPLOYEES = [
  {
    id: 7,
    name: '北美运营分析员',
    description: '负责北美站经营分析',
    avatar_url: null,
    employee_type: 'AI_AGENT',
    status: 'RUNNING',
    last_heartbeat_at: '2026-11-14T03:00:00Z',
    is_silent_alert_threshold_minutes: 30,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-14T03:00:00Z',
  },
  {
    id: 8,
    name: '库存健康巡检员',
    description: '检查库存健康度',
    avatar_url: null,
    employee_type: 'MONITORING',
    status: 'IDLE',
    last_heartbeat_at: '2026-11-14T02:55:00Z',
    is_silent_alert_threshold_minutes: 30,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-14T02:55:00Z',
  },
  {
    id: 9,
    name: '广告投放复盘员',
    description: '复盘广告投放效果',
    avatar_url: null,
    employee_type: 'SCHEDULED_JOB',
    status: 'FAILED',
    last_heartbeat_at: '2026-11-14T02:50:00Z',
    is_silent_alert_threshold_minutes: 30,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-14T02:50:00Z',
  },
]

const EMPLOYEE_TASKS = {
  items: [
    {
      id: 701,
      task_id: 'task-701',
      task_name: '生成北美站周报',
      task_type: 'AI_ANALYSIS',
      status: 'RUNNING',
      progress_percent: 42,
      current_step: '汇总广告数据',
      started_at: '2026-11-14T02:40:00Z',
      ended_at: null,
      error_message: null,
      metadata_json: null,
      created_at: '2026-11-14T02:40:00Z',
    },
  ],
  total: 1,
}

const OFFICE_EMPLOYEES = EMPLOYEES.map((employee, index) => ({
  employee_id: employee.id,
  name: employee.name,
  persona: {
    emoji: index === 0 ? '📊' : index === 1 ? '📦' : '📣',
    color_key: 'amber',
    tagline: employee.description,
  },
  display_status: index === 2 ? 'FAILED' : index === 1 ? 'IDLE' : 'WORKING',
  busy_level: index === 0 ? 'BUSY' : 'NORMAL',
  queued_count: index,
  pace: 1.1,
  current_task: {
    task_id: `task-${employee.id}`,
    task_name: '生成经营周报',
    status: index === 2 ? 'FAILED' : 'RUNNING',
  },
  work_item: {
    project_name: index === 1 ? '欧洲增长店' : '北美旗舰店',
    report_label: index === 1 ? '库存健康' : '经营周报',
  },
  virtual_progress: index === 2 ? 100 : 42,
  step_label: index === 2 ? '等待重试' : '汇总广告数据',
  today_done: 2 + index,
  success_rate: index === 2 ? 0.86 : 0.98,
  last_heartbeat_at: '2026-11-14T03:00:00Z',
}))

const CHAT_CONFIG = {
  providerConfigured: true,
  webSearchConfigured: true,
  models: ['MiniMax-M3', 'OtherModel-01'],
  defaultModel: 'MiniMax-M3',
  premiumModels: ['MiniMax-M3'],
  basicModels: ['OtherModel-01'],
  reasoningModels: [],
  defaultReasoningEffort: 'medium',
  timeoutSeconds: 60,
  maxConversationTurns: 10,
  webSearchMaxResults: 5,
  overviewOptions: [],
  detailOptions: [],
  scenarios: [],
}

const CHAT_CONVERSATIONS = [
  {
    id: 1,
    title: '今日销售复盘',
    created_at: '2026-11-14T01:00:00Z',
    updated_at: '2026-11-14T02:00:00Z',
    total_prompt_tokens: 820,
    total_completion_tokens: 410,
    total_tokens: 1230,
  },
  {
    id: 2,
    title: '库存异常排查',
    created_at: '2026-11-13T01:00:00Z',
    updated_at: '2026-11-13T02:00:00Z',
    total_prompt_tokens: 320,
    total_completion_tokens: 160,
    total_tokens: 480,
  },
]

const CHAT_MESSAGES = [
  {
    id: 11,
    conversation_id: 1,
    role: 'user',
    content: '帮我总结今天的销售表现',
    search_sources: [],
    is_complete: true,
    prompt_tokens: 12,
    completion_tokens: 0,
    total_tokens: 12,
    duration_ms: null,
    created_at: '2026-11-14T02:00:00Z',
  },
  {
    id: 12,
    conversation_id: 1,
    role: 'assistant',
    content: '昨日广告花费偏高，建议优先复核北美站的核心投放组。',
    search_sources: [],
    is_complete: true,
    prompt_tokens: 0,
    completion_tokens: 36,
    total_tokens: 36,
    duration_ms: 1200,
    created_at: '2026-11-14T02:01:00Z',
  },
]

async function expectNoPageHorizontalOverflow(page: Page) {
  const offenders = await page.evaluate(() => {
    const clipsX = (element: Element) => {
      const overflow = getComputedStyle(element).overflowX
      return /(auto|scroll|hidden|clip)/.test(overflow)
    }
    const hasClippingAncestor = (element: Element) => {
      let current = element.parentElement
      while (current) {
        if (clipsX(current)) return true
        current = current.parentElement
      }
      return false
    }
    const candidates: Element[] = [document.documentElement, document.body]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((element) => element.scrollWidth - element.clientWidth > 2)
      .filter((element) => !clipsX(element) && !hasClippingAncestor(element))
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className).slice(0, 160),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
  })
  if (offenders.length > 0) {
    console.log('AI_MOBILE_OVERFLOW=' + JSON.stringify(offenders))
  }
  expect(offenders, '页面级容器不应出现横向溢出').toEqual([])
}

async function expectInsideViewport(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox()
  expect(box, `${label} should have a box`).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(
    viewport.width + 1
  )
}

async function expectSameRow(a: Locator, b: Locator, label: string) {
  const boxA = await a.boundingBox()
  const boxB = await b.boundingBox()
  expect(boxA, `${label} first element`).not.toBeNull()
  expect(boxB, `${label} second element`).not.toBeNull()
  expect(Math.abs(boxA!.y - boxB!.y), label).toBeLessThan(2)
}

async function expectBelow(upper: Locator, lower: Locator, label: string) {
  const upperBox = await upper.boundingBox()
  const lowerBox = await lower.boundingBox()
  expect(upperBox, `${label} upper element`).not.toBeNull()
  expect(lowerBox, `${label} lower element`).not.toBeNull()
  expect(lowerBox!.y, label).toBeGreaterThan(
    upperBox!.y + upperBox!.height - 1
  )
}

async function installMocks(page: Page) {
  await page.route('**/api/ai-chat/config', (route) =>
    route.fulfill({ json: CHAT_CONFIG })
  )
  await page.route('**/api/ai-chat/conversations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: CHAT_CONVERSATIONS })
    } else {
      await route.continue()
    }
  })
  await page.route('**/api/ai-chat/conversations/*/messages', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: CHAT_MESSAGES })
    } else {
      await route.continue()
    }
  })

  await page.route('**/api/backend/api/v1/projects/manage', (route) =>
    route.fulfill({ json: PROJECTS })
  )

  await page.route('**/api/backend/v1/ai-insights*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/schedules')) {
      await route.fulfill({ json: { items: [], total: 0 } })
      return
    }
    if (url.pathname === '/api/backend/v1/ai-insights') {
      const type = url.searchParams.get('insight_type')
      await route.fulfill({
        json: {
          items:
            type === 'ad_analysis'
              ? [{ ...INSIGHTS[0], id: 201, title: '广告分析样例', insight_type: 'ad_analysis' }]
              : INSIGHTS,
          total: 1,
        },
      })
      return
    }
    await route.continue()
  })

  await page.route(
    '**/api/backend/api/v1/digital-employees',
    (route) => route.fulfill({ json: { items: EMPLOYEES, total: EMPLOYEES.length } })
  )
  await page.route(
    '**/api/backend/api/v1/digital-employees/**',
    async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname.replace(/\/+$/, '')
      if (path.endsWith('/office/stream')) {
        const snapshot = {
          server_time: '2026-11-14T03:00:00Z',
          employees: OFFICE_EMPLOYEES,
        }
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
          body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        })
        return
      }
      if (path.endsWith('/7/tasks')) {
        await route.fulfill({ json: EMPLOYEE_TASKS })
        return
      }
      if (path.endsWith('/7/recent-logs')) {
        await route.fulfill({
          json: {
            items: [
              {
                id: 1,
                task_id: 701,
                level: 'INFO',
                message: '已拉取北美站近 7 天经营数据',
                created_at: '2026-11-14T02:55:00Z',
              },
            ],
          },
        })
        return
      }
      if (path.endsWith('/7')) {
        await route.fulfill({ json: EMPLOYEES[0] })
        return
      }
      await route.fulfill({ json: { items: [], total: 0 } })
    }
  )
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'AI Stage 7 phone regression runs in the mobile project'
  )
})

test.beforeEach(async ({ page, context }) => {
  await addBLF611FixtureAuth(context)
  await installMocks(page)
})

test.describe('@mobile-blf1510 AI chat', () => {
  test('keeps history, messages, composer, and send action reachable on phones', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/chat')
    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await expect(chatWindow).toBeVisible({ timeout: 20000 })
    await expect(page.getByPlaceholder('输入消息，开始对话...')).toBeVisible()

    const toggle = page.getByRole('button', { name: '打开对话历史' })
    await toggle.click()
    const history = page.getByTestId('ai-chat-history-panel')
    await expect(history).toBeVisible()
    const historyBox = (await history.boundingBox())!
    const viewport = page.viewportSize()!
    expect(historyBox.width).toBeLessThanOrEqual(viewport.width * 0.93)

    await page.getByText('今日销售复盘').first().click()
    await expect(page.getByText('昨日广告花费偏高，建议优先复核北美站的核心投放组。')).toBeVisible()
    await expect(page.getByPlaceholder('继续对话...')).toBeVisible()

    const send = page.getByRole('button', { name: '发送' })
    const sendBox = (await send.boundingBox())!
    expect(sendBox.width, '发送按钮触控宽度').toBeGreaterThanOrEqual(44)
    expect(sendBox.height, '发送按钮触控高度').toBeGreaterThanOrEqual(44)
    await expectInsideViewport(page, send, '发送按钮')

    const textarea = page.locator('[data-testid="ai-chat-window"] textarea')
    const fontSize = await textarea.evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).fontSize)
    )
    expect(fontSize, '手机聊天输入字号不应触发浏览器自动缩放').toBeGreaterThanOrEqual(16)

    await page.getByRole('button', { name: '打开对话历史' }).click()
    await expect(history).toBeVisible()
    await page.getByTestId('ai-chat-sidebar-scrim').click({
      position: { x: viewport.width - 16, y: 120 },
    })
    await expect(history).toBeHidden()
    await expect(page.getByRole('button', { name: '打开对话历史' })).toBeFocused()
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1510 digital employees', () => {
  test('reflows the list, stats, and employee detail without page overflow', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/digital-employees')
    const stats = page.getByTestId('digital-employee-stats')
    await expect(stats).toBeVisible({ timeout: 20000 })
    const statCards = stats.locator(':scope > div')
    await expect(statCards).toHaveCount(4)
    await expectSameRow(statCards.nth(0), statCards.nth(1), '前两个员工指标应同行')
    await expectBelow(statCards.nth(1), statCards.nth(2), '员工指标第二行应折行')

    const roster = page.locator('[data-warm-employee-roster="true"]')
    const cards = roster.locator('[role="button"]')
    await expect(cards).toHaveCount(3)
    await expectInsideViewport(page, cards.first(), '第一个数字员工卡片')
    await cards.first().click()

    const profile = page.getByTestId('digital-employee-profile')
    await expect(profile).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible()
    const grid = page.getByTestId('digital-employee-detail-grid')
    const columns = grid.locator(':scope > div')
    await expect(columns).toHaveCount(2)
    const mainBox = (await columns.nth(0).boundingBox())!
    const railBox = (await columns.nth(1).boundingBox())!
    expect(railBox.y, '详情侧栏应折到主列下方').toBeGreaterThan(
      mainBox.y + mainBox.height - 1
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('gives the virtual office and presentation mode a phone layout', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/digital-employees/office')
    const officeGrid = page.getByTestId('digital-office-grid')
    await expect(officeGrid).toBeVisible({ timeout: 20000 })
    const officeCards = officeGrid.locator('[data-testid="office-employee"]')
    await expect(officeCards).toHaveCount(3)
    const firstBox = (await officeCards.nth(0).boundingBox())!
    const secondBox = (await officeCards.nth(1).boundingBox())!
    expect(Math.abs(firstBox.x - secondBox.x), '办公室卡片应单列排列').toBeLessThan(2)
    expect(secondBox.y, '第二张办公室卡片应折行').toBeGreaterThan(
      firstBox.y + firstBox.height - 1
    )
    await expectInsideViewport(page, officeCards.first(), '第一张办公室卡片')
    await expectNoPageHorizontalOverflow(page)

    await page.goto('/dashboard/ai/digital-employees/office?mode=presentation')
    await expect(page.locator('[data-office-presentation="true"]')).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('html')).not.toHaveClass(/light/)
    const presentationCards = page.getByTestId('office-employee')
    await expect(presentationCards).toHaveCount(3)
    const p1 = (await presentationCards.nth(0).boundingBox())!
    const p2 = (await presentationCards.nth(1).boundingBox())!
    expect(Math.abs(p1.x - p2.x), '投屏卡片应单列排列').toBeLessThan(2)
    expect(p2.y, '投屏第二张卡片应折行').toBeGreaterThan(p1.y + p1.height - 1)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1510 AI insights and ad analysis', () => {
  test('reflows insight filters and keeps the complete history table scrollable', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/insights')
    await expect(page.getByRole('tab', { name: '洞察记录' })).toBeVisible({
      timeout: 20000,
    })
    const filters = page.getByTestId('ai-insights-filters')
    await expect(filters).toBeVisible()

    const project = page.locator('#insight-project')
    const country = page.locator('#insight-country')
    const insightType = page.locator('#insight-type')
    await expect(project).toBeVisible({ timeout: 20000 })
    await expectSameRow(country, insightType, '国家与洞察类型应同行')
    await expectBelow(project, country, '项目筛选应排在站点筛选上方')
    await expectInsideViewport(page, project, '项目筛选')
    await expectInsideViewport(page, insightType, '洞察类型筛选')

    const generate = page.getByRole('button', { name: '生成洞察' })
    const filtersBox = (await filters.boundingBox())!
    const generateBox = (await generate.boundingBox())!
    expect(generateBox.width, '生成洞察按钮应占满表单宽度').toBeGreaterThan(
      filtersBox.width * 0.9
    )

    await expect(page.getByText('2026-11 销售洞察')).toBeVisible({ timeout: 20000 })
    const tableScroll = page.getByTestId('ai-insights-table-scroll')
    const scroll = await tableScroll.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scroll.overflowX, '洞察历史应采用容器内横向滚动').toBe('auto')
    expect(scroll.scrollWidth, '洞察历史应保留完整列宽').toBeGreaterThan(
      scroll.clientWidth + 100
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('stacks ad-analysis filters and keeps its history in a touch scroller', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/ad-analysis')
    await expect(page.getByRole('tab', { name: '历史记录' })).toBeVisible({
      timeout: 20000,
    })
    const filters = page.getByTestId('ai-ad-filters')
    await expect(filters).toBeVisible()
    const project = page.locator('#ad-project')
    const country = page.locator('#ad-country')
    await expectBelow(project, country, '广告分析筛选项应单列堆叠')
    await expectInsideViewport(page, country, '广告分析站点筛选')

    await expect(page.getByText('广告分析样例')).toBeVisible({ timeout: 20000 })
    const tableScroll = page.getByTestId('ai-ad-history-table-scroll')
    const scroll = await tableScroll.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scroll.overflowX, '广告历史应采用容器内横向滚动').toBe('auto')
    expect(scroll.scrollWidth, '广告历史应保留完整列宽').toBeGreaterThan(
      scroll.clientWidth + 100
    )
    await expectInsideViewport(
      page,
      page.getByRole('button', { name: '立即生成' }),
      '立即生成按钮'
    )
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1510 AI forms and document surfaces', () => {
  test('keeps customer-service controls and generated cards usable', async ({ page }) => {
    await page.goto('/dashboard/ai/customer-service')
    await expect(page.getByRole('button', { name: '生成', exact: true })).toBeVisible({
      timeout: 20000,
    })
    const workspace = page.getByTestId('customer-service-workspace')
    await expect(workspace).toBeVisible()
    const generate = page.getByRole('button', { name: '生成', exact: true })
    const workspaceBox = (await workspace.boundingBox())!
    const generateBox = (await generate.boundingBox())!
    expect(generateBox.width, '客服生成按钮应占满手机操作行').toBeGreaterThan(
      workspaceBox.width * 0.85
    )
    await expectInsideViewport(page, generate, '客服生成按钮')
    await expectNoPageHorizontalOverflow(page)
  })

  test('stacks inventory-health filters and keeps the generate action visible', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/inventory-health')
    await expect(page.getByRole('button', { name: '立即生成' })).toBeVisible({
      timeout: 20000,
    })
    const filters = page.getByTestId('ai-inventory-health-filters')
    const fields = filters.locator(':scope > *')
    await expectBelow(fields.nth(0), fields.nth(1), '库存健康筛选项应单列堆叠')
    await expectInsideViewport(page, fields.nth(0), '库存健康项目筛选')
    await expectNoPageHorizontalOverflow(page)
  })

  test('keeps the model document metadata and wide table inside the phone layout', async ({
    page,
  }) => {
    await page.goto('/dashboard/ai/believeboy-models')
    await expect(
      page.getByRole('heading', { name: /模型对比表/ })
    ).toBeVisible({ timeout: 20000 })
    const tableScroll = page.getByTestId('believeboy-models-table-scroll').first()
    const scroll = await tableScroll.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scroll.overflowX, '模型对比表应采用容器内横向滚动').toBe('auto')
    expect(scroll.scrollWidth, '模型对比表应保留完整列宽').toBeGreaterThan(
      scroll.clientWidth + 100
    )
    await expectInsideViewport(
      page,
      page.getByRole('link', { name: /查看原始 markdown/ }),
      '查看原始 Markdown 链接'
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('keeps the AI landing entry visible and overflow-free', async ({ page }) => {
    await page.goto('/dashboard/ai')
    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await expect(chatWindow).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('link', { name: '进入 AI Chat' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1510 compact phones', () => {
  const compactRoutes = [
    '/dashboard/ai',
    '/dashboard/ai/chat',
    '/dashboard/ai/insights',
    '/dashboard/ai/ad-analysis',
    '/dashboard/ai/customer-service',
    '/dashboard/ai/digital-employees',
    '/dashboard/ai/digital-employees/7',
    '/dashboard/ai/digital-employees/office',
    '/dashboard/ai/inventory-health',
    '/dashboard/ai/believeboy-models',
  ] as const

  test('keeps all ten AI routes free of page-level horizontal overflow at 320px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    for (const route of compactRoutes) {
      await page.goto(route)
      await expect(page.locator('#main-content, [data-testid="ai-chat-window"]').first()).toBeVisible({
        timeout: 20000,
      })
      await expectNoPageHorizontalOverflow(page)
    }
  })
})

test.describe('@mobile-blf1510 V4 themes', () => {
  test('keeps the AI insight form and history usable in both themes', async ({ page }) => {
    await page.goto('/dashboard/ai/insights')
    await expect(page.getByTestId('ai-insights-filters')).toBeVisible({
      timeout: 20000,
    })

    await page.evaluate(() => localStorage.setItem('theme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.getByRole('tab', { name: '洞察记录' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)

    await page.evaluate(() => localStorage.setItem('theme', 'light'))
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect(page.getByRole('tab', { name: '洞察记录' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf1510 desktop regression', () => {
  test('keeps the AI insights and employee surfaces wide at 1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/ai/insights')
    await expect(page.getByRole('tab', { name: '洞察记录' })).toBeVisible({
      timeout: 20000,
    })
    await expect(page.locator('#insight-project')).toBeVisible({ timeout: 20000 })
    await expectSameRow(
      page.locator('#insight-project'),
      page.locator('#insight-country'),
      '桌面洞察筛选应横向排列'
    )
    await expectNoPageHorizontalOverflow(page)

    await page.goto('/dashboard/ai/digital-employees/office')
    const officeGrid = page.getByTestId('digital-office-grid')
    await expect(officeGrid).toBeVisible({ timeout: 20000 })
    const officeCards = officeGrid.locator('[data-testid="office-employee"]')
    await expect(officeCards).toHaveCount(3)
    await expectSameRow(officeCards.nth(0), officeCards.nth(1), '桌面办公室应保持多列')
    await expectNoPageHorizontalOverflow(page)
  })
})
