import { expect, test, type Locator, type Page } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

/**
 * Stage 7 tools/document mobile regression (BLF-1511).
 *
 * Covers the five tool routes at 390px and the 320px lower bound:
 * - the shared dock stays visible and the page never scrolls horizontally;
 * - split tool workspaces stack, panel actions stay reachable;
 * - generated output keeps its own scroller instead of stretching the page;
 * - text inputs use a 16px phone font so iOS does not zoom the keyboard;
 * - the page-render HTML preview keeps its white paper canvas.
 */

const SESSION = {
  user: {
    id: '1',
    name: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    fullName: 'E2E',
  },
  expires: '2099-01-01T00:00:00.000Z',
}

const TOOL_ROUTES = [
  { path: '/dashboard/tools/brand-registration-example', title: '品牌备案示例' },
  { path: '/dashboard/tools/cross-border-compliance', title: '跨境电商合规' },
  { path: '/dashboard/tools/markdown-to-word', title: 'Markdown 转 Word' },
  { path: '/dashboard/tools/page-render', title: 'Markdown / HTML 渲染' },
  { path: '/dashboard/tools/product-label', title: '产品标签制作' },
] as const

const HISTORY_ROWS = Array.from({ length: 24 }, (_, index) => ({
  id: `page-${index + 1}`,
  title: `季度公告 ${index + 1}`,
  source_format: index % 2 === 0 ? 'markdown' : 'html',
  public_url: `https://cdn.example.com/page-${index + 1}`,
  original_filename: `quarterly-${index + 1}.md`,
  file_size: 2048 + index,
  created_at: '2026-11-04T08:00:00.000Z',
}))

async function mockBackend(page: Page): Promise<void> {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/notifications/**', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 20 } })
  )
  await page.route('**/api/backend/api/v1/order-info/live-stream**', (route) =>
    route.fulfill({ json: { items: [] } })
  )
  await page.route('**/api/changelog-latest', (route) =>
    route.fulfill({ json: { version: 'e2e', entries: [] } })
  )
  await page.route('**/api/backend/api/v1/page-render/history**', (route) =>
    route.fulfill({ json: { items: HISTORY_ROWS, total: HISTORY_ROWS.length } })
  )
  await page.route('**/api/backend/api/v1/page-render/upload', (route) =>
    route.fulfill({
      json: {
        ...HISTORY_ROWS[0],
        id: 'page-new',
        title: 'E2E 公告',
        original_filename: 'notice.html',
      },
    })
  )
}

async function expectNoPageHorizontalOverflow(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const candidates: Element[] = [document.documentElement, document.body]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((element) => element.scrollWidth - element.clientWidth > 2)
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
  })
  expect(offenders, '页面级容器不应出现横向溢出').toEqual([])
}

async function expectTouchTargets(dock: Locator): Promise<void> {
  const items = dock.locator('.warm-ledger__dock-item')
  const count = await items.count()
  expect(count).toBe(5)
  for (let index = 0; index < count; index += 1) {
    const box = await items.nth(index).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
}

async function expectStacked(page: Page, selector: string, count = 2): Promise<void> {
  const panels = page.locator(selector)
  expect(await panels.count()).toBeGreaterThanOrEqual(count)
  const first = await panels.nth(0).boundingBox()
  const second = await panels.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 2)
}

test.beforeEach(async ({ page, context }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'tools-mobile-blf1511 仅在 mobile project 运行（断言依赖手机端视口）'
  )
  await mockBackend(page)
  await addBLF611FixtureAuth(context)
})

test.describe('@blf-1511 工具与文档页面 手机端', () => {
  test('390px：五个工具页都保留 Dock，且没有页面级横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const dock = page.getByRole('navigation', { name: '移动主导航' })

    for (const route of TOOL_ROUTES) {
      await page.goto(route.path)
      const breadcrumb = page.getByRole('navigation', { name: '面包屑' })
      await expect(breadcrumb).toContainText(route.title)
      await expect(dock).toBeVisible()
      await expectTouchTargets(dock)
      await expectNoPageHorizontalOverflow(page)
    }
  })

  test('320px：五个工具页仍可使用且不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    const dock = page.getByRole('navigation', { name: '移动主导航' })

    for (const route of TOOL_ROUTES) {
      await page.goto(route.path)
      await expect(dock).toBeVisible()
      await expectNoPageHorizontalOverflow(page)
      const main = page.locator('#main-content')
      const box = await main.boundingBox()
      expect(box!.width).toBeLessThanOrEqual(320)
    }
  })

  test('Markdown 转换：编辑区与预览纵向堆叠，手机键盘字号 16px，长预览在内部滚动', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/tools/markdown-to-word')

    await expectStacked(page, '[data-tools-panel="true"]')
    const textarea = page.getByLabel('Markdown 内容')
    expect(await textarea.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px')

    const markdown = Array.from(
      { length: 28 },
      (_, index) => `## 章节 ${index + 1}\n\n这里是第 ${index + 1} 段用于验证长文档预览的滚动效果。`
    ).join('\n\n')
    await textarea.fill(markdown)

    const preview = page.getByTestId('markdown-preview')
    await expect(preview.getByRole('heading', { name: '章节 1', exact: true })).toBeVisible()
    const previewMetrics = await preview.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: getComputedStyle(element).maxHeight,
    }))
    expect(previewMetrics.clientHeight).toBeLessThanOrEqual(520)
    expect(previewMetrics.scrollHeight).toBeGreaterThan(previewMetrics.clientHeight)
    expect(previewMetrics.maxHeight).toContain('px')

    await expect(page.getByRole('button', { name: /下载 Word/ })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '移动主导航' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })

  test('页面渲染：标题输入 16px，历史表在内部滚动，HTML 预览保持白纸画布', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/tools/page-render')

    const titleInput = page.getByLabel('页面标题（可选，留空使用文件名）')
    expect(await titleInput.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
      '16px'
    )

    const table = page.locator('table')
    await expect(table.getByText('季度公告 1', { exact: true })).toBeVisible()
    const scrollerMetrics = await table.evaluate((element) => {
      const scroller = element.parentElement!
      return {
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        overflowY: getComputedStyle(scroller).overflowY,
        overflowX: getComputedStyle(scroller).overflowX,
      }
    })
    expect(scrollerMetrics.clientHeight).toBeLessThanOrEqual(480)
    expect(scrollerMetrics.scrollHeight).toBeGreaterThan(scrollerMetrics.clientHeight)
    expect(scrollerMetrics.overflowY).toBe('auto')
    expect(scrollerMetrics.overflowX).toBe('auto')

    const html = '<!doctype html><html><body><h1>白纸画布</h1></body></html>'
    await page.locator('input[type="file"]').setInputFiles({
      name: 'notice.html',
      mimeType: 'text/html',
      buffer: Buffer.from(html),
    })
    const iframe = page.getByTitle('HTML 预览')
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(iframe).toHaveAttribute('data-preview-surface', 'paper')
    expect(await iframe.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgb(255, 255, 255)'
    )

    await expect(page.getByRole('navigation', { name: '移动主导航' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)
  })

  test('产品标签：两块面板纵向堆叠，输入 16px，生成操作在视口内', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/tools/product-label')

    await expectStacked(page, '[data-tools-panel="true"]')
    expect(
      await page
        .locator('#product-label-text')
        .evaluate((element) => getComputedStyle(element).fontSize)
    ).toBe('16px')

    const generate = page.getByRole('button', { name: /生成并下载/ })
    await expect(generate).toBeVisible()
    await expect(generate).toBeInViewport()
    const box = await generate.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await expectNoPageHorizontalOverflow(page)
  })

  test('品牌备案：拍摄网格两列重排，页面无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/tools/brand-registration-example')

    const boxGrid = page.locator('[data-photo-grid="box"]')
    const cards = boxGrid.locator('figure')
    const first = await cards.nth(0).boundingBox()
    const second = await cards.nth(1).boundingBox()
    const third = await cards.nth(2).boundingBox()
    expect(first!.y).toBe(second!.y)
    expect(third!.y).toBeGreaterThan(first!.y + 8)
    await expectNoPageHorizontalOverflow(page)
  })

  test('跨境电商合规：锚点触控尺寸达标，宽表在自身容器内横滑', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/tools/cross-border-compliance')

    const anchorLinks = page.getByRole('navigation', { name: '页内导航' }).getByRole('link')
    const count = await anchorLinks.count()
    expect(count).toBe(5)
    for (let index = 0; index < count; index += 1) {
      const box = await anchorLinks.nth(index).boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }

    const chainCards = page.locator('#chain > ol > li')
    await expect(chainCards).toHaveCount(5)
    const first = await chainCards.nth(0).boundingBox()
    const second = await chainCards.nth(1).boundingBox()
    expect(second!.y).toBeGreaterThan(first!.y + first!.height - 2)

    const tableScroller = page
      .locator('#modes table')
      .first()
      .locator('xpath=..')
    const metrics = await tableScroller.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }))
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
    expect(metrics.overflowX).toBe('auto')
    await expectNoPageHorizontalOverflow(page)
  })
})
