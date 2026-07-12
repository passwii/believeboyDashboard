import { test, expect } from '@playwright/test'

// 沿用 tests/setup/global-setup.ts 的 auth 模式：依赖 ./tests/.auth/user.json 注入登录态。
// 本地/CI 跑前需先执行 `pnpm exec playwright test --global-setup` 或让 webServer
// 配套跑 setup。本 spec 默认与全局 webServer 配置配合；如本地无登录态，
// 会因 middleware/auth 拦截而失败，这是预期信号（提示先跑 setup）。
test.use({ storageState: './tests/.auth/user.json' })

const aiChatConfig = {
  providerConfigured: true,
  webSearchConfigured: false,
  models: [
    'MiniMax-M3',
    'OtherModel-01',
    'OtherModel-02',
    'OtherModel-03',
    'OtherModel-04',
    'OtherModel-05',
    'OtherModel-06',
    'OtherModel-07',
    'OtherModel-08',
    'OtherModel-09',
  ],
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
}

test.describe('/dashboard/ai-chat viewport regression', () => {
  test.beforeEach(async ({ page }) => {
    // mock 后端 config，避免真实 LLM 网关被触发；同时保证页面有最小可观测的渲染
    await page.route('**/api/ai-chat/config', async (route) => {
      await route.fulfill({ json: aiChatConfig })
    })
  })

  test('AIChatWindow fills viewport (no height collapse)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/ai-chat')

    // 等待 AIChatWindow 渲染（chat 流 / 模型加载可能耗时）
    const chatWindow = page.locator('[data-testid="ai-chat-window"]').first()
    await chatWindow.waitFor({ state: 'visible', timeout: 15000 })

    // 断言 boundingBox 高度 ≥ 视口高度的 80%，宽度 ≥ 视口宽度的 80%
    // （留 20% 容差，应对 scrollbar / sidebar 偏移等）
    const box = await chatWindow.boundingBox()
    const viewport = page.viewportSize()
    expect(box, 'AIChatWindow boundingBox should not be null').not.toBeNull()
    expect(viewport, 'viewport should not be null').not.toBeNull()
    if (box && viewport) {
      expect(box.height).toBeGreaterThanOrEqual(viewport.height * 0.8)
      expect(box.width).toBeGreaterThanOrEqual(viewport.width * 0.8)
    }
  })
})
