import { test, expect } from '@playwright/test'

// 公海领取 E2E（3.10）。
// 依赖全局登录态 ./tests/.auth/user.json。数据来自 MockCrmClient（scope='sea'）。
test.use({ storageState: './tests/.auth/user.json' })

test.describe('公海领取（3.10）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/crm/sea')
    await expect(page.getByRole('cell').first()).toBeVisible({ timeout: 15000 })
  })

  test('公海列表渲染（ownerId 为空的客户）', async ({ page }) => {
    // 至少有一条公海客户
    await expect(page.getByRole('row').nth(1)).toBeVisible()
  })

  test('点击行打开抽屉，"领取"后从公海移除并提示', async ({ page }) => {
    const firstRow = page.getByRole('row').nth(1)
    const rowName = (await firstRow.innerText()).split('\n')[0]
    await firstRow.click()

    const claimBtn = page.getByRole('button', { name: '领取' })
    await expect(claimBtn).toBeVisible({ timeout: 10000 })
    await claimBtn.click()

    // 领取成功 toast
    await expect(page.getByText('已领取客户')).toBeVisible({ timeout: 10000 })
    // 抽屉关闭
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 公海列表为前端 Mock，领取后需重载才会重新拉取 scope='sea'
    await page.reload()
    await expect(page.getByRole('cell').first()).toBeVisible({ timeout: 15000 })
    // 该行不再出现在公海（被领取后 ownerId 赋值，脱离公海）
    await expect(page.getByText(rowName, { exact: true })).toHaveCount(0)
  })
})
