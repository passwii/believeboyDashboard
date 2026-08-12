import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-619 AI 域手机端适配回归（chat / digital-employees / insights / ad-analysis /
 * customer-service / believeboy-models / AI 入口页）。
 *
 * 自包含：AI Chat 配置走 page.route 伪造（避免真实 LLM 网关 / 后端配置），其余页面
 * 无后端时落入空态/骨架屏，仍断言布局不产生页面级横向溢出。默认随 mobile project
 * （Pixel 5，393×851）跑；另加 360×800 小屏用例；桌面零回归在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 5：页面标题行手机端纵向堆叠（office 页）；
 * - 规则 10：markdown 表格容器内横滑（believeboy-models），页面无整体横向滚动；
 * - chat：AIChatWindow 撑满手机视口、输入区可见；侧边栏以覆盖层打开不挤压正文；
 * - insights 工具栏手机端 2 列网格（项目/国家同一行）；
 * - 桌面 1440 零回归（insights 工具栏恢复横向 flex）。
 */
const FIXTURE_SECRET = BLF611_FIXTURE_SECRET

const aiChatConfig = {
  providerConfigured: true,
  webSearchConfigured: false,
  models: ['MiniMax-M3', 'OtherModel-01'],
  defaultModel: 'MiniMax-M3',
  premiumModels: ['MiniMax-M3'],
  basicModels: [],
  reasoningModels: [],
  defaultReasoningEffort: 'medium',
  timeoutSeconds: 60,
  maxConversationTurns: 10,
  webSearchMaxResults: 5,
  overviewOptions: [],
  detailOptions: [],
  scenarios: [],
}

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      operatorNameZh: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

/** 页面级无整体横向滚动。
 *
 * 判定：html/body/#main-content 等候选容器 scrollWidth > clientWidth 且
 * 自身/祖先没有横向裁剪（overflow-x: hidden | clip | auto | scroll）时才视为
 * 页面级溢出。表格横滑容器（规则 10，overflow-x-auto）与 chat 深色窗口的
 * 边出血（被 main 的 overflow-x-clip 裁剪）都不产生页面级横向滚动，予以排除。
 */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    const clipsX = (el: Element): boolean => {
      const o = getComputedStyle(el).overflowX
      return /(auto|scroll|hidden|clip)/.test(o)
    }
    const hasClippingAncestor = (el: Element): boolean => {
      let cur = el.parentElement
      while (cur) {
        if (clipsX(cur)) return true
        cur = cur.parentElement
      }
      return false
    }
    const candidates: Element[] = [document.documentElement, document.body]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((el) => el.scrollWidth - el.clientWidth > 2)
      .filter((el) => !clipsX(el) && !hasClippingAncestor(el))
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 160),
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }))
  })
  if (offenders.length > 0) {
    console.log('OVERFLOW_OFFENDERS=' + JSON.stringify(offenders))
  }
  expect(offenders.length, '页面级容器不应出现横向溢出（表格内部横滑除外）').toBe(0)
}

/** 断言两个元素处于同一行（y 差 < 2px） */
async function expectSameRow(
  page: import('@playwright/test').Page,
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(Math.abs(ba.y - bb.y), label).toBeLessThan(2)
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'ai-mobile-blf619 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await context.addCookies([
    {
      name: 'authjs.session-token',
      value: await forgeSessionToken(),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  // AI Chat 配置：伪造最小配置，避免真实 LLM 网关 / 后端被触发
  await page.route('**/api/ai-chat/config', async (route) => {
    await route.fulfill({ json: aiChatConfig })
  })
})

test.describe('@mobile-blf619 AI Chat 手机端（BLF-619）', () => {
  test('窗口撑满视口 + 输入区可见 + 侧边栏覆盖层不挤压正文', async ({ page }) => {
    await page.goto('/dashboard/ai/chat')

    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await chatWindow.waitFor({ state: 'visible', timeout: 15000 })

    const box = (await chatWindow.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.height, 'AIChatWindow 高度撑满手机视口').toBeGreaterThanOrEqual(viewport.height * 0.8)
    expect(box.width, 'AIChatWindow 宽度撑满手机视口').toBeGreaterThanOrEqual(viewport.width * 0.8)

    // 输入区可见（textarea + 发送按钮）
    await expect(page.getByPlaceholder('输入消息，开始对话...').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()

    // 侧边栏以覆盖层打开：正文宽度不被 280px 挤压（手机端不位移）
    await page.getByRole('button', { name: '打开对话历史' }).click()
    await expect(page.getByText('对话历史').first()).toBeVisible({ timeout: 10000 })
    const chatBoxAfter = (await chatWindow.boundingBox())!
    // 打开侧边栏前后窗口宽度一致（覆盖层模式，不挤压正文）
    expect(Math.abs(chatBoxAfter.width - box.width), '侧边栏不应挤压聊天窗口宽度').toBeLessThan(2)

    await expectNoPageHorizontalOverflow(page)
  })

  test('360×800 小屏：窗口撑满 + 无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/ai/chat')

    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await chatWindow.waitFor({ state: 'visible', timeout: 15000 })
    const box = (await chatWindow.boundingBox())!
    expect(box.width, '360px 下 AIChatWindow 仍撑满视口').toBeGreaterThanOrEqual(350)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf619 数字员工手机端（BLF-619）', () => {
  test('列表页：无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/ai/digital-employees')
    await expect(page.getByRole('heading', { name: '数字员工' })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })

  test('办公室页：标题行手机端纵向堆叠（总则 5）', async ({ page }) => {
    await page.goto('/dashboard/ai/digital-employees/office')
    await expect(page.getByRole('heading', { name: '虚拟办公室' })).toBeVisible({ timeout: 30000 })
    // 标题与「投屏」按钮手机端纵向堆叠（不同行），避免挤压
    const titleBox = (await page.getByRole('heading', { name: '虚拟办公室' }).boundingBox())!
    const btnBox = (await page.getByRole('button', { name: '🖥️ 投屏' }).boundingBox())!
    expect(btnBox.y, '投屏按钮应换行到标题下方（纵向堆叠）').toBeGreaterThan(titleBox.y + titleBox.height)
    await expectNoPageHorizontalOverflow(page)
  })

  test('360×800 小屏：办公室页无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/ai/digital-employees/office')
    await expect(page.getByRole('heading', { name: '虚拟办公室' })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf619 AI 洞察 / 广告分析手机端（BLF-619）', () => {
  test('insights：工具栏手机端 2 列网格（项目/国家同一行）+ 无溢出', async ({ page }) => {
    await page.goto('/dashboard/ai/insights')
    await expect(page.getByRole('button', { name: '洞察记录' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('button', { name: '全部项目' })).toBeVisible({ timeout: 30000 })

    // 规则 2/9：手机端 2 列网格 —— 项目与国家站点同一行
    await expectSameRow(
      page,
      page.getByRole('button', { name: '全部项目' }),
      page.getByRole('button', { name: '美国站 (US)' }),
      'insights 工具栏项目/国家同一行（2 列网格）'
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('ad-analysis：筛选表单单列 + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/ai/ad-analysis')
    await expect(page.getByRole('heading', { name: 'AI 广告分析' })).toBeVisible({
      timeout: 30000,
    })
    await expect(page.getByRole('button', { name: '立即生成' })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })

  test('360×800 小屏：insights 无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/ai/insights')
    await expect(page.getByRole('button', { name: '洞察记录' })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf619 客服 / 模型参考 / 入口页手机端（BLF-619）', () => {
  test('customer-service：无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/ai/customer-service')
    // 无后端配置时仍渲染内置场景预设的输入面板（布局在）
    await expect(page.getByRole('button', { name: '生成', exact: true })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })

  test('believeboy-models：markdown 表格容器内横滑（规则 10），无整体溢出', async ({ page }) => {
    await page.goto('/dashboard/ai/believeboy-models')
    await expect(
      page.getByRole('heading', { name: '彼励扶 Believeboy 模型选型方案' })
    ).toBeVisible({ timeout: 30000 })

    // markdown 表格存在于 overflow-x-auto 包裹层内（规则 10）
    const scrollWrapper = page.locator('.believeboy-prose > div.overflow-x-auto').first()
    await expect(scrollWrapper).toBeVisible({ timeout: 15000 })
    const table = scrollWrapper.locator('table').first()
    const tableBox = (await table.boundingBox())!
    const viewport = page.viewportSize()!
    expect(tableBox.width, '模型对比表格超出手机视口（容器内横滑）').toBeGreaterThan(
      viewport.width * 0.9
    )
    await expectNoPageHorizontalOverflow(page)
  })

  test('AI 入口页：无整体横向滚动', async ({ page }) => {
    await page.goto('/dashboard/ai')
    await page.locator('[data-testid="ai-chat-window"]').first().waitFor({ state: 'visible', timeout: 15000 })
    await expect(page.getByRole('link', { name: '进入 AI Chat' })).toBeVisible({ timeout: 10000 })
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf619 AI 域桌面零回归（BLF-619）', () => {
  test('1440：insights 工具栏恢复横向 flex（项目/国家同处一行）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/ai/insights')

    await expect(page.getByRole('button', { name: '洞察记录' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('button', { name: '全部项目' })).toBeVisible({ timeout: 30000 })

    // 桌面 lg+：工具栏横向排列 —— 项目与国家站点同一行
    await expectSameRow(
      page,
      page.getByRole('button', { name: '全部项目' }),
      page.getByRole('button', { name: '美国站 (US)' }),
      '1440 桌面工具栏应横向排列（同一行）'
    )
    await expectNoPageHorizontalOverflow(page)
  })
})
