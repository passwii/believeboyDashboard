import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-1508 手机端软键盘回归。
 *
 * iOS Safari 的 visualViewport 在键盘弹出时会缩小/上移，而 fixed 元素仍留在
 * layout viewport（WebKit 259770）。CRM 通过 CrmVisualViewportSync 把
 * visualViewport 几何写入 CSS 变量。这里在移动端 Chromium 上注入一个可控的
 * visualViewport，验证抽屉与底部弹层在“键盘占用 291px”时仍把关闭/提交动作
 * 留在可视区内。
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '仅在 mobile project 运行')
})

test.beforeEach(async ({ context }) => {
  const token = await encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      fullName: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
  await context.addCookies([
    {
      name: 'authjs.session-token',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
})

async function installKeyboardViewport(page: Page, height = 560) {
  await page.addInitScript((keyboardHeight) => {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const viewport = {
      width: 393,
      height: keyboardHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const set = listeners.get(type) ?? new Set<(event: Event) => void>()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent: () => true,
    }
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => viewport,
    })
    ;(window as unknown as { __setKeyboardHeight: (height: number) => void }).__setKeyboardHeight = (
      next: number
    ) => {
      viewport.height = next
      for (const listener of listeners.get('resize') ?? []) listener(new Event('resize'))
    }
  }, height)
}

async function expectKeyboardInset(page: Page, expected: string) {
  const value = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--crm-keyboard-inset-bottom')
  )
  expect(value.trim()).toBe(expected)
}

test('记录抽屉在软键盘出现后仍保持全屏可视，关闭按钮可达', async ({ page }) => {
  await installKeyboardViewport(page)
  await page.goto('/dashboard/crm/customers')

  await expect(page.getByText('共 100 条')).toBeVisible({ timeout: 30000 })
  await page.locator('#main-content tbody tr').first().click()

  const drawer = page.locator('[data-warm-crm-record-drawer]')
  await expect(drawer).toBeVisible({ timeout: 15000 })

  const viewport = page.viewportSize()!
  await expectKeyboardInset(page, `${viewport.height - 560}px`)

  const drawerBox = (await drawer.boundingBox())!
  expect(drawerBox.y).toBeLessThanOrEqual(1)
  expect(drawerBox.height, '抽屉高度应收缩到可视视口').toBeLessThanOrEqual(561)

  const closeBox = (await page.getByRole('button', { name: '关闭' }).boundingBox())!
  expect(closeBox.y).toBeGreaterThanOrEqual(drawerBox.y)
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(drawerBox.y + 561)

  await page.evaluate(() => {
    ;(window as unknown as { __setKeyboardHeight: (height: number) => void }).__setKeyboardHeight(480)
  })
  await expectKeyboardInset(page, `${viewport.height - 480}px`)
  const resized = (await drawer.boundingBox())!
  expect(resized.height, '键盘变高后抽屉继续收缩').toBeLessThanOrEqual(481)
})

test('方案弹层在软键盘出现后保持在可视区，关闭与提交可达', async ({ page }) => {
  await installKeyboardViewport(page)
  await page.goto('/dashboard/crm/proposals')

  await page.getByRole('button', { name: '新建方案' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })

  const viewport = page.viewportSize()!
  await expectKeyboardInset(page, `${viewport.height - 560}px`)

  const dialogBox = (await dialog.boundingBox())!
  expect(dialogBox.y + dialogBox.height, '弹层底边应贴在可视视口底部').toBeLessThanOrEqual(561)

  const closeBox = (await page.getByRole('button', { name: 'Close' }).boundingBox())!
  expect(closeBox.y).toBeGreaterThanOrEqual(dialogBox.y)
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(561)

  await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const submit = page.getByRole('button', { name: '上传并创建' })
  await expect(submit).toBeVisible()
  const submitBox = (await submit.boundingBox())!
  expect(submitBox.y + submitBox.height, '提交按钮应滚入可视区').toBeLessThanOrEqual(561)
})
