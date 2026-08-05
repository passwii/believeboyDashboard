/**
 * Agent 凭据管理页功能巡检（Agent API P0 spec §7.2）。
 *
 * 覆盖：页面渲染 / 创建弹窗（明文只展示一次）/ 吊销。
 * 创建出的测试凭据会在用例内吊销，不留脏数据。
 *
 * Run:
 *   pnpm test:ui -- tests/crawl/agent-management.spec.ts --project=chromium
 *
 * Required env (backend/.env.test, gitignored): TEST_USER_EMAIL, TEST_USER_PASSWORD
 */
import { test, expect, type Page } from '@playwright/test'

const AUTH_FILE = 'tests/.auth/user.json'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3200'

// 与 discovery.spec.ts 保持一致的登录实现
async function loginAsUser(page: Page): Promise<void> {
  const email = process.env.TEST_USER_EMAIL
  const password = process.env.TEST_USER_PASSWORD
  if (!email || !password) {
    throw new Error(
      'loginAsUser requires TEST_USER_EMAIL and TEST_USER_PASSWORD ' +
        '(set in backend/.env.test — gitignored, never committed).'
    )
  }
  const context = page.context()
  try {
    const fs = await import('node:fs')
    if (fs.existsSync(AUTH_FILE)) {
      const cached = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
      if (cached.cookies) await context.addCookies(cached.cookies)
      const session = await context.request.get(`${BASE_URL}/api/auth/session`)
      const data = (await session.json()) as { user?: { id?: string | number } }
      if (data?.user?.id) return
    }
  } catch {
    /* fall through */
  }
  const csrfResp = await context.request.get(`${BASE_URL}/api/auth/csrf`)
  const csrfToken = ((await csrfResp.json()) as { csrfToken?: string }).csrfToken
  if (!csrfToken) throw new Error(`NextAuth CSRF fetch failed: ${csrfResp.status()}`)
  const resp = await context.request.post(
    `${BASE_URL}/api/auth/callback/credentials`,
    {
      form: { csrfToken, email, password, json: 'true' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
    }
  )
  if (resp.status() !== 200 && resp.status() !== 302) {
    throw new Error(
      `NextAuth login failed: ${resp.status()} ${(await resp.text()).slice(0, 200)}`
    )
  }
  try {
    const fs = await import('node:fs')
    fs.mkdirSync('tests/.auth', { recursive: true })
    fs.writeFileSync(AUTH_FILE, JSON.stringify(await context.storageState()), 'utf-8')
  } catch {
    /* best-effort */
  }
}

const TEST_LABEL = `pw-agent-${Date.now()}`
const TEST_AGENT_ID = 'pw-crawl-agent'

test.describe('Agent 凭据管理页', () => {
  test('列表渲染 + 创建（明文一次）+ 吊销', async ({ page }) => {
    await loginAsUser(page)
    await page.goto('/dashboard/system/agent-management', {
      waitUntil: 'networkidle',
      timeout: 30000,
    })

    // 页面渲染
    await expect(page.getByRole('heading', { name: /Agent 凭据管理/ })).toBeVisible()
    await expect(page.getByText('Key 前缀')).toBeVisible()

    // 创建
    await page.getByRole('button', { name: '创建凭据' }).click()
    await page.getByLabel('名称').fill(TEST_LABEL)
    await page.getByLabel('Agent ID').fill(TEST_AGENT_ID)
    await page.getByRole('button', { name: '创建', exact: true }).click()

    // 明文只展示一次
    await expect(page.getByText('凭据创建成功')).toBeVisible()
    await expect(page.getByText('明文仅展示一次')).toBeVisible()
    await expect(page.getByText(TEST_AGENT_ID).first()).toBeVisible()
    await page.getByRole('button', { name: '关闭' }).click()

    // 列表出现新行
    const row = page.getByRole('row').filter({ hasText: TEST_LABEL })
    await expect(row).toBeVisible()
    await expect(row.getByText(TEST_AGENT_ID)).toBeVisible()

    // 吊销（自动清理；确认弹窗是 AlertDialog，role=alertdialog）
    await row.getByRole('button', { name: '吊销' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '吊销' })
      .click()
    await expect(row.getByText('已吊销')).toBeVisible({ timeout: 10000 })
  })

  test('创建时可选项目范围白名单，列表展示项目名', async ({ page }) => {
    await loginAsUser(page)
    await page.goto('/dashboard/system/agent-management', {
      waitUntil: 'networkidle',
      timeout: 30000,
    })

    await page.getByRole('button', { name: '创建凭据' }).click()
    const dialog = page.getByRole('dialog')

    // 默认「全部项目」勾选
    const allToggle = dialog.getByRole('button', { name: /全部项目/ })
    await expect(allToggle).toBeVisible()

    const scopeLabel = `${TEST_LABEL}-scope`
    await dialog.getByLabel('名称').fill(scopeLabel)
    await dialog.getByLabel('Agent ID').fill(TEST_AGENT_ID)

    // 取消「全部项目」→ 打开多选，选第一个具体项目（若无项目选项则回退全部）
    await allToggle.click()
    const combobox = dialog.getByRole('combobox')
    await combobox.click()
    const options = dialog.getByRole('option')
    const optionCount = await options.count()

    let expectedScope: string
    if (optionCount > 0) {
      const first = options.first()
      const name = ((await first.textContent()) ?? '').trim()
      await first.click()
      expectedScope = name
    } else {
      await allToggle.click()
      expectedScope = '全部项目'
    }

    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(page.getByText('凭据创建成功')).toBeVisible()
    await page.getByRole('button', { name: '关闭' }).click()

    // 列表出现新行且展示项目范围
    const row = page.getByRole('row').filter({ hasText: scopeLabel })
    await expect(row).toBeVisible()
    await expect(row.getByText(expectedScope)).toBeVisible()

    // 吊销（自动清理）
    await row.getByRole('button', { name: '吊销' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '吊销' })
      .click()
    await expect(row.getByText('已吊销')).toBeVisible({ timeout: 10000 })
  })
})
