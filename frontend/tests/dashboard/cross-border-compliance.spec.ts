import { expect, test, type Page } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

/**
 * 跨境电商合规页（/dashboard/tools/cross-border-compliance）用户流程 E2E —— BLF-1393 阶段 3 收口。
 *
 * 覆盖设计稿《跨境电商合规操作台》的 7 条验收标准里可自动化的部分：
 * 1. 从「工具箱」进入合规页（L1 主轨「工具箱」→ L2 子导航「跨境电商合规」）；
 * 2. 顶部标题显示「跨境电商合规」而非默认 `Dashboard`（面包屑 + 页内 <h1>）；
 * 3. 来源提示「根据用户提供的课件整理」与限制性提示可见；
 * 4. 勾选首单材料 → 进度文本变化（已核对 n/N · 完成 p%）；
 * 5. 「重置」回到 0/N · 完成 0%；
 * 6. 窄屏（375 / 390 / 768px）无整体横向溢出（表格自身在 overflow-x-auto 容器内横滑，不算溢出），
 *    且 5 个页内锚点逐个可跳转、目标区块进入视口（并断言 URL hash 真的切到该锚点）；
 * 7. 明暗主题切换下页面仍可读、进度交互仍生效（主题令牌在两态下都可解析）；
 * 8. 勾选 / **取消勾选** / 重置全程零非 GET 请求 → 勾选状态确实只存在于本地 state。
 *
 * 自包含：session cookie 用 next-auth/jwt encode 伪造（BLF611_FIXTURE_SECRET，与
 * playwright.config webServer.env 一致），**不依赖真实后端 / 真实账号**；
 * 页面上一切后端请求（notifications / live-stream / changelog）经 page.route mock，
 * 因此本 spec 可在无 .env.local、无后端的环境直接跑。
 *
 * 认证说明（关键）：proxy.ts（next-auth v5 auth 中间件）用 NextAuth `jwt` 回调读
 * token 字段 `uid` / `isAdmin` / `roleType` / `operatorNameZh` / `sessionId`，
 * 而**不是** `session.user.id`。fixture 里的 token 正是按这几个字段编码的，
 * 故 uid='1' 的 admin 会话能通过 proxy 的 `/dashboard` 守卫。
 */

/** 与 `compliance-data.ts` 的 TOTAL_MATERIAL_COUNT 一致（20 条 = 五组之和）。 */
const TOTAL_MATERIALS = 20

const SESSION = {
  user: {
    id: '1',
    name: 'E2E',
    email: 'e2e@example.com',
    roleType: 'admin',
    fullName: 'E2E',
    operatorNameZh: 'E2E',
  },
  expires: '2099-01-01T00:00:00.000Z',
}

/** 拦截页面上一切后端调用，避免依赖真实后端。 */
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
}

/**
 * 页面级横向溢出断言：文档根 + #main-content 都不得出现整体横向滚动。
 *
 * 说明：Terminal Shell 的滚动容器是 `#main-content`（`overflow-x-clip overflow-y-auto`），
 * document 本身不滚动，所以「页面整体横向溢出」要看 #main-content 的 scrollWidth。
 * 课件对照表等宽表放在 `overflow-x-auto` 容器里，容器自身横滑不算页面溢出。
 */
async function expectNoPageHorizontalOverflow(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const candidates: Element[] = [document.documentElement, document.body]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((el) => el.scrollWidth - el.clientWidth > 2)
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }))
  })
  expect(offenders, '页面级容器不应出现横向溢出（等宽表在 overflow-x-auto 容器内横滑）').toEqual([])
}

/**
 * 健壮的主题切换：等菜单真正打开、选中后等菜单真正卸载。
 *
 * 为什么不用「点一下就选」：共享组件 `theme-mode-picker.tsx`（Radix DropdownMenu）自带
 * 80ms hover 开启 + 160ms 关闭延迟，菜单关闭动画期间元素会被 detach，直接连点会
 * 偶发 `element was detached from the DOM`（在 `/dashboard` 等无关页面同样复现，
 * 是该共享组件的既有竞态，与本页无关）。等菜单完全卸载再进行下一次切换即可稳定。
 */
async function pickTheme(page: Page, name: '浅色' | '深色'): Promise<void> {
  await page.getByRole('button', { name: /主题设置：/ }).click()
  const item = page.getByRole('menuitemradio', { name })
  await expect(item).toBeVisible({ timeout: 10000 })
  await item.click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(0, { timeout: 10000 })
}

test.use({ storageState: { cookies: [], origins: [] } })

test.beforeEach(async ({ page, context }) => {
  await mockBackend(page)
  await addBLF611FixtureAuth(context)
})

test.describe('跨境电商合规页用户流程（BLF-1393）', () => {
  test('从「工具箱」进入合规页：标题、来源提示与五步证据链可见', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/dashboard')

    // 1. 从 L1 主轨的「工具箱」进入（图标按钮，aria-label = 组名）。
    const toolsRailButton = page.getByRole('button', { name: '工具箱' })
    await expect(toolsRailButton).toBeVisible()
    await toolsRailButton.click()

    // 2. L2 子导航展开「工具箱」分组，点「跨境电商合规」进入目标页。
    const complianceLink = page.getByRole('link', { name: '跨境电商合规' }).first()
    await expect(complianceLink).toBeVisible()
    await complianceLink.click()

    await expect(page).toHaveURL(/\/dashboard\/tools\/cross-border-compliance$/)
    await expect(page.getByRole('heading', { level: 1, name: '跨境电商合规' })).toBeVisible()

    // 3. 顶部标题显示「跨境电商合规」而非默认 `Dashboard`（面包屑 + document.title）。
    const breadcrumb = page.getByRole('navigation', { name: '面包屑' })
    await expect(breadcrumb).toContainText('跨境电商合规')
    await expect(breadcrumb).not.toContainText('Dashboard')
    await expect(page).toHaveTitle(/跨境电商合规/)

    // 4. 来源提示与限制性提示可见（硬性验收项）。
    await expect(page.getByText('来源：根据用户提供的课件整理')).toBeVisible()
    await expect(page.getByText(/不构成法律、税务或报关意见/)).toBeVisible()

    // 5. 五步出口业务证据链：采购 → 销售 → 报关 → 物流 → 收汇 全部渲染。
    const chain = page.locator('#chain')
    await expect(chain).toBeVisible()
    for (const stage of ['采购', '销售', '报关', '物流', '收汇']) {
      await expect(chain.getByRole('heading', { level: 3, name: stage })).toBeVisible()
    }
  })

  test('勾选首单材料后进度文本变化，「重置」回到 0/N', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })

    // AC4 后半句：勾选状态**不得**发往后端（纯本地）。记录本页所有非 GET 请求，
    // 勾选/取消/重置三态跑完后断言其数量为 0。
    const mutatingRequests: string[] = []
    page.on('request', (request) => {
      const method = request.method().toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        mutatingRequests.push(`${method} ${request.url()}`)
      }
    })

    await page.goto('/dashboard/tools/cross-border-compliance')

    const progress = page.getByTestId('material-progress')
    await expect(progress).toBeVisible()

    // 初始态：0/N · 完成 0%
    await expect(progress).toHaveText(`已核对 0/${TOTAL_MATERIALS} · 完成 0%`)

    // 勾选 3 条 → 3/N · 完成 15%（3/20 = 15%）
    const checkboxes = page.getByRole('checkbox')
    await expect(checkboxes).toHaveCount(TOTAL_MATERIALS)

    await checkboxes.nth(0).click()
    await expect(progress).toHaveText(`已核对 1/${TOTAL_MATERIALS} · 完成 5%`)

    await checkboxes.nth(4).click()
    await checkboxes.nth(11).click()
    await expect(progress).toHaveText(`已核对 3/${TOTAL_MATERIALS} · 完成 15%`)

    // 取消勾选（组件里的 `next.has(id)` 删除分支）：进度必须回落。
    // 必须真的走一遍「取消」——否则「取消勾选也零非 GET 请求」这条断言是空的：
    // 一个只在删除分支发 POST 的回归会整条溜过去。
    await checkboxes.nth(4).click()
    await expect(progress).toHaveText(`已核对 2/${TOTAL_MATERIALS} · 完成 10%`)
    await expect(checkboxes.nth(4)).not.toBeChecked()

    // 再勾回来 → 3/N · 15%（取消不是单向的，进度可增可减）。
    await checkboxes.nth(4).click()
    await expect(progress).toHaveText(`已核对 3/${TOTAL_MATERIALS} · 完成 15%`)
    await expect(checkboxes.nth(4)).toBeChecked()

    // 「重置」恢复 0/N · 完成 0%
    await page.getByRole('button', { name: '重置' }).click()
    await expect(progress).toHaveText(`已核对 0/${TOTAL_MATERIALS} · 完成 0%`)
    await expect(checkboxes.nth(0)).not.toBeChecked()
    await expect(checkboxes.nth(11)).not.toBeChecked()

    // 勾选 / 取消勾选 / 重置全程零非 GET 请求 → 勾选状态确实只存在于组件本地 state。
    expect(mutatingRequests, '勾选状态不得发往后端（应为零非 GET 请求）').toEqual([])
  })

  test('窄屏无整体横向溢出，且 5 个页内锚点逐个可跳转', async ({ page }) => {
    // 三档窄屏视口逐档验证「页面整体无横向滚动」。
    // 375 / 390 / 768 是设计稿点名的三档；这里显式 setViewportSize（不依赖 project
    // 的 Pixel 5 = 393px），保证三档都被真正覆盖。
    for (const width of [375, 390, 768]) {
      await page.setViewportSize({ width, height: 812 })
      await page.goto('/dashboard/tools/cross-border-compliance')
      await expect(page.getByRole('heading', { level: 1, name: '跨境电商合规' })).toBeVisible()
      await expectNoPageHorizontalOverflow(page)
    }

    // 页内锚点：5 个分组锚点逐个点击，每个都必须把目标区块滚进视口。
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/dashboard/tools/cross-border-compliance')

    const anchors = [
      { id: 'chain', label: /业务证据链/ },
      { id: 'modes', label: /监管模式对照/ },
      { id: 'admission', label: /企业准入办理/ },
      { id: 'materials', label: /9810 退税与首单清单/ },
      { id: 'fields', label: /报关字段速查/ },
    ] as const

    for (const anchor of anchors) {
      const section = page.locator(`#${anchor.id}`)
      await expect(section).toBeAttached()

      // 必须断言「点击真的换了 hash」，不能只看 toBeInViewport：
      // 首个锚点 `chain` 在页面载入时（滚到顶部）本来就已在视口内，
      // 一个 href 写坏 / 点击无反应的回归会让 toBeInViewport 空转通过。
      // 先记下点击前的 hash，再断言它切实切到了本锚点的 hash。
      const hashBefore = await page.evaluate(() => window.location.hash)
      expect(hashBefore, `锚点 ${anchor.id} 点击前不应已经是目标 hash`).not.toBe(`#${anchor.id}`)

      await page.getByRole('link', { name: anchor.label }).first().click()
      await expect(page).toHaveURL(new RegExp(`#${anchor.id}$`))
      await expect(section).toBeInViewport({ timeout: 5000 })
      // 锚点跳转后仍不得引入整体横向溢出。
      await expectNoPageHorizontalOverflow(page)
    }
  })

  test('明暗主题切换下标题、来源提示与勾选交互均可用', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/dashboard/tools/cross-border-compliance')

    const heading = page.getByRole('heading', { level: 1, name: '跨境电商合规' })
    await expect(heading).toBeVisible()

    // 主题选择器在 L1 主轨底部（aria-label = 「主题设置：<当前模式>」），是下拉菜单而非直接切换。
    await expect(page.getByRole('button', { name: /主题设置：/ })).toBeVisible()
    await pickTheme(page, '深色')
    await expect(page.locator('html')).toHaveClass(/dark/)

    // 暗色下标题、来源提示仍可见（主题令牌两态都可解析），勾选交互仍生效。
    await expect(heading).toBeVisible()
    await expect(page.getByText('来源：根据用户提供的课件整理')).toBeVisible()

    const progress = page.getByTestId('material-progress')
    await page.getByRole('checkbox').first().click()
    await expect(progress).toHaveText(`已核对 1/${TOTAL_MATERIALS} · 完成 5%`)

    // 切回浅色，勾选状态保持（组件本地 state，不随主题重置）。
    await pickTheme(page, '浅色')
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(progress).toHaveText(`已核对 1/${TOTAL_MATERIALS} · 完成 5%`)
  })
})
