import { test, expect } from '@playwright/test'

const viewports = [
  { width: 390, height: 844, name: 'mobile' },
  { width: 1440, height: 900, name: 'desktop' },
]

function getContrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${color}`)
    const [r, g, b] = channels.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

test.describe('BelieveBoy login responsive entry', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  for (const viewport of viewports) {
    test(`${viewport.name}: brand and login form fit without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/login')

      if (viewport.name === 'desktop') {
        await expect(page.getByRole('heading', { level: 1, name: '彼励扶跨境' })).toBeVisible()
        await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
      } else {
        await expect(page.getByRole('img', { name: 'BelieveBoy' })).toBeVisible()
        await expect(page.getByRole('heading', { level: 1, name: '彼励扶跨境' })).toBeAttached()
        await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
      }
      await expect(page.getByLabel('企业邮箱')).toBeVisible()
      await expect(page.getByLabel('登录密码')).toBeVisible()
      const submit = page.getByRole('button', { name: /登录工作区/ })
      await expect(submit).toBeVisible()
      if (viewport.name === 'mobile') {
        await expect(submit).toBeInViewport()
      }
      await expect(submit).toHaveCSS('box-shadow', 'none')
      const submitContrast = await submit.evaluate((element) => {
        const style = window.getComputedStyle(element)
        return { foreground: style.color, background: style.backgroundColor }
      })
      expect(getContrastRatio(submitContrast.foreground, submitContrast.background)).toBeGreaterThanOrEqual(4.5)
      await expect(page.getByRole('button', { name: '显示密码' })).toHaveCSS('box-shadow', 'none')
      const placeholders = await page.locator('input').evaluateAll((inputs) => inputs.map((input) => {
        const style = window.getComputedStyle(input)
        const placeholder = window.getComputedStyle(input, '::placeholder')
        return { foreground: placeholder.color, background: style.backgroundColor }
      }))
      for (const colors of placeholders) {
        expect(getContrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5)
      }
      await expect
        .poll(() => page.locator('body').evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0)
    })
  }

  test('keyboard focus keeps terminal controls square', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')

    await page.getByLabel('企业邮箱').focus()
    await expect(page.getByLabel('企业邮箱')).toHaveCSS('border-radius', '0px')
    await page.getByRole('button', { name: '显示密码' }).focus()
    await expect(page.getByRole('button', { name: '显示密码' })).toHaveCSS('border-radius', '0px')
  })

  test('theme toggle switches the term color theme', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')
    const root = page.locator('html')
    const toggle = page.getByRole('button', { name: /切换到深色模式/ })

    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveCSS('box-shadow', 'none')
    await toggle.click()
    await expect(root).toHaveClass(/dark/)
    await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
  })

  test('mobile screen reader order keeps one level-one brand heading', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')

    await expect(page.getByRole('heading', { level: 1, name: '彼励扶跨境' })).toBeAttached()
    await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })

  test('reduced motion keeps brand and form immediately visible', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')

    await expect(page.getByRole('img', { name: 'BelieveBoy' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: '彼励扶跨境' })).toBeAttached()
    await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
    await expect(page.getByLabel('企业邮箱')).toBeVisible()
  })
})
