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
 * 6. 桌面 1440×900 无整体横向溢出（表格自身在 overflow-x-auto 容器内横滑，不算溢出），
 *    且 5 个页内锚点逐个可跳转、目标区块进入视口（并断言 URL hash 真的切到该锚点）；
 * 7. Warm Ledger 表面令牌生效，进度交互仍可用；
 * 8. 勾选 / **取消勾选** / 重置全程零非 GET 请求 → 勾选状态确实只存在于本地 state。
 *
 * 自包含：session cookie 用 next-auth/jwt encode 伪造（BLF611_FIXTURE_SECRET，与
 * playwright.config webServer.env 一致），**不依赖真实后端 / 真实账号**；
 * 页面上一切后端请求（notifications / live-stream / changelog）经 page.route mock，
 * 因此本 spec 可在无 .env.local、无后端的环境直接跑。
 *
 * 认证说明（关键）：proxy.ts（next-auth v5 auth 中间件）用 NextAuth `jwt` 回调读
 * token 字段 `uid` / `isAdmin` / `roleType` / `sessionId`，
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
 * 说明：Warm Ledger 的滚动容器是 `#main-content`（`overflow-x-clip overflow-y-auto`），
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

test.use({ storageState: { cookies: [], origins: [] } })

test.beforeEach(async ({ page, context }) => {
  await mockBackend(page)
  await addBLF611FixtureAuth(context)
})

test.describe('跨境电商合规页用户流程（BLF-1393）', () => {
  test('从「工具箱」进入合规页：标题、来源提示与五步证据链可见', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    // 1. V4 主导航按业务域展开，工具箱下的合规链接直接可见。
    const navigation = page.getByRole('navigation', { name: '业务域和快捷入口' })
    await expect(navigation.getByText('工具箱', { exact: true })).toBeVisible()
    const complianceLink = navigation.getByRole('link', { name: '跨境电商合规' })
    await expect(complianceLink).toBeVisible()
    await complianceLink.click()

    // 2. 进入目标页后，V4 路由元数据负责面包屑与页内标题。
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
    await page.setViewportSize({ width: 1440, height: 900 })

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

  test('桌面 1440×900 无整体横向溢出，且 5 个页内锚点逐个可跳转', async ({ page }) => {
    // V4 Warm Ledger 页面迁移仅验收桌面 1440×900，不新增移动端断点改造。
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/tools/cross-border-compliance')
    await expect(page.getByRole('heading', { level: 1, name: '跨境电商合规' })).toBeVisible()
    await expectNoPageHorizontalOverflow(page)

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

  test('Warm Ledger 表面令牌生效，来源提示与勾选交互可用', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/tools/cross-border-compliance')

    const heading = page.getByRole('heading', { level: 1, name: '跨境电商合规' })
    await expect(heading).toBeVisible()

    const frameStyles = await page
      .locator('[data-tools-page-frame="true"]')
      .evaluate((element) => {
        const styles = getComputedStyle(element)
        const shell = document.querySelector('.warm-ledger')
        return {
          color: styles.color,
          fontFamily: styles.fontFamily,
          shellFontFamily: shell ? getComputedStyle(shell).fontFamily : '',
          accent: styles.getPropertyValue('--warm-ledger-color-accent').trim(),
        }
      })
    expect(frameStyles.color).toBe('rgb(241, 237, 229)')
    expect(frameStyles.fontFamily).toBe(frameStyles.shellFontFamily)
    expect(frameStyles.accent).toBe('#e8b35a')

    const panelStyles = await page
      .locator('[data-tools-panel="true"]')
      .first()
      .evaluate((element) => {
        const styles = getComputedStyle(element)
        return {
          backgroundColor: styles.backgroundColor,
          borderRadius: styles.borderRadius,
        }
      })
    expect(panelStyles.backgroundColor).toBe('rgb(43, 44, 43)')
    expect(panelStyles.borderRadius).toBe('16px')

    await expect(heading).toBeVisible()
    await expect(page.getByText('来源：根据用户提供的课件整理')).toBeVisible()

    const progress = page.getByTestId('material-progress')
    await page.getByRole('checkbox').first().click()
    await expect(progress).toHaveText(`已核对 1/${TOTAL_MATERIALS} · 完成 5%`)
  })
})
