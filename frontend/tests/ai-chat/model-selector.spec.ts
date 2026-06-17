import { expect, test } from '@playwright/test'

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

test.describe('AI Chat model selector', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/ai-chat/config', async (route) => {
      await route.fulfill({ json: aiChatConfig })
    })
  })

  test('desktop other-model panel opens beside the dropdown and scrolls internally', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/model-selector-test')

    const trigger = page.getByText('MiniMax M3').first()
    await expect(trigger).toBeVisible()
    await trigger.click()

    await expect(page.getByText('选择模型')).toBeVisible()
    await page.getByTestId('model-selector-others-toggle').click()

    const menu = page.getByTestId('model-selector-menu')
    const sidePanel = page.getByTestId('model-selector-other-panel')
    await expect(menu).toBeVisible()
    await expect(sidePanel).toBeVisible()

    const menuBox = await menu.boundingBox()
    const sideBox = await sidePanel.boundingBox()
    expect(menuBox, 'menu should be measurable').not.toBeNull()
    expect(sideBox, 'other-model panel should be measurable').not.toBeNull()

    if (!menuBox || !sideBox) return

    expect(sideBox.x, 'other-model panel should open to the right of the dropdown').toBeGreaterThan(menuBox.x + menuBox.width - 2)
    expect(sideBox.y, 'other-model panel should align with the top of the dropdown').toBeLessThanOrEqual(menuBox.y + 8)
    expect(sideBox.height, 'other-model panel should be capped by max-h').toBeGreaterThan(0)
    expect(sideBox.height, 'other-model panel should not exceed 60vh at this viewport').toBeLessThanOrEqual(540)
    await expect(page.getByTestId('model-selector-backdrop')).toHaveCount(0)

    const overflowY = await sidePanel.evaluate((el) => getComputedStyle(el).overflowY)
    expect(overflowY, 'other-model panel should scroll internally').toBe('auto')
  })
})
