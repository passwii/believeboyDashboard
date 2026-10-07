import { test, expect, type Page } from '@playwright/test'

const viewports = [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 820, height: 1180, name: 'tablet' },
  { width: 390, height: 844, name: 'mobile' },
] as const

const themes = ['light', 'dark'] as const

type Theme = (typeof themes)[number]

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

async function setTheme(page: Page, theme: Theme) {
  const root = page.locator('html')
  const isDark = await root.evaluate((element) => element.classList.contains('dark'))
  if (isDark !== (theme === 'dark')) await page.locator('.theme-button').click()
  if (theme === 'dark') {
    await expect(root).toHaveClass(/dark/)
  } else {
    await expect(root).not.toHaveClass(/dark/)
  }
}

test.describe('BelieveBoy login themes and responsive entry', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${viewport.name} ${theme}: brand and form are coordinated without horizontal overflow`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto('/login')
        await expect(page.locator('.theme-button')).toBeVisible()
        await setTheme(page, theme)

        await expect(page.getByRole('heading', { level: 1, name: /跨境电商\s*运营工作区/ })).toBeVisible()
        await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
        await expect(page.getByLabel('企业邮箱')).toBeVisible()
        await expect(page.getByLabel('登录密码')).toBeVisible()

        const colors = await page.locator('.brand-panel').evaluate((panel) => {
          const style = window.getComputedStyle(panel)
          const heading = window.getComputedStyle(panel.querySelector('h1')!)
          const copy = window.getComputedStyle(panel.querySelector('p')!)
          const form = window.getComputedStyle(document.querySelector('.form-panel')!)
          return {
            background: style.backgroundColor,
            heading: heading.color,
            copy: copy.color,
            form: form.backgroundColor,
          }
        })
        expect(colors.background).not.toBe(colors.form)
        expect(getContrastRatio(colors.heading, colors.background)).toBeGreaterThanOrEqual(4.5)
        expect(getContrastRatio(colors.copy, colors.background)).toBeGreaterThanOrEqual(4.5)
        if (theme === 'light') {
          expect(colors.background).toBe('rgb(238, 242, 236)')
          expect(colors.form).toBe('rgb(255, 255, 255)')
        } else {
          expect(colors.background).toBe('rgb(8, 13, 9)')
          expect(colors.form).toBe('rgb(17, 17, 20)')
        }

        const placeholders = await page.locator('input').evaluateAll((inputs) => inputs.map((input) => {
          const style = window.getComputedStyle(input)
          const placeholder = window.getComputedStyle(input, '::placeholder')
          return { foreground: placeholder.color, background: style.backgroundColor }
        }))
        for (const colors of placeholders) {
          expect(getContrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5)
        }

        const submit = page.getByRole('button', { name: /登录工作区/ })
        await expect(submit).toBeVisible()
        if (viewport.name === 'mobile') await expect(submit).toBeInViewport()
        const submitColors = await submit.evaluate((element) => {
          const style = window.getComputedStyle(element)
          return { foreground: style.color, background: style.backgroundColor }
        })
        expect(getContrastRatio(submitColors.foreground, submitColors.background)).toBeGreaterThanOrEqual(4.5)

        await expect
          .poll(() => page.locator('body').evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBe(0)

        await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${theme}.png`), fullPage: true })
      })
    }
  }

  test('theme toggle switches the complete login palette in both directions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')
    const brandPanel = page.locator('.brand-panel')
    const themeToggle = page.locator('.theme-button')

    await setTheme(page, 'light')
    await expect(brandPanel).toHaveCSS('background-color', 'rgb(238, 242, 236)')
    await themeToggle.click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(brandPanel).toHaveCSS('background-color', 'rgb(8, 13, 9)')
    await themeToggle.click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(brandPanel).toHaveCSS('background-color', 'rgb(238, 242, 236)')
  })

  test('reduced motion holds the workspace route artwork still', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')

    await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
    expect(
      await page.locator('.route-wire-live').first().evaluate((element) => window.getComputedStyle(element).animationName)
    ).toBe('none')
  })
})
