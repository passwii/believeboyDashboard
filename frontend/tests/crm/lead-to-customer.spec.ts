import { test, expect } from '@playwright/test'

// CRM 线索 → 客户闭环 E2E（3.6）。
// 依赖全局登录态 ./tests/.auth/user.json（由 tests/setup/global-setup.ts 生成）。
// 数据来自前端 MockCrmClient（localStorage 持久化），无需后端。
test.use({ storageState: './tests/.auth/user.json' })

test.describe('线索 → 客户（3.6）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/crm/leads')
    // 等待线索表格渲染（首行出现）
    await expect(page.getByRole('cell').first()).toBeVisible({ timeout: 15000 })
  })

  test('点击行打开详情抽屉', async ({ page }) => {
    const firstRow = page.getByRole('row').nth(1)
    await firstRow.click()
    // 抽屉标题 / 详情 tab 出现
    await expect(page.getByRole('tab', { name: '详情' })).toBeVisible()
  })

  test('详情抽屉"转为客户"触发转化闭环', async ({ page }) => {
    const firstRow = page.getByRole('row').nth(1)
    await firstRow.click()
    const convertBtn = page.getByRole('button', { name: '转为客户' })
    await expect(convertBtn).toBeVisible({ timeout: 10000 })
    await convertBtn.click()
    // 转化成功 toast
    await expect(page.getByText('已转化为客户')).toBeVisible({ timeout: 10000 })
  })

  test('"新建线索"打开表单并校验必填', async ({ page }) => {
    await page.getByRole('button', { name: '新建线索' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 不填联系人直接提交 → 校验报错
    await dialog.getByRole('button', { name: '创建线索' }).click()
    await expect(page.getByText('联系人必填')).toBeVisible()
  })
})
