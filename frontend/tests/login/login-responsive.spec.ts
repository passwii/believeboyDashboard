import { test, expect, type Page } from '@playwright/test'

const viewports = [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 820, height: 1180, name: 'tablet' },
  { width: 390, height: 844, name: 'mobile' },
] as const

const themes = ['light', 'dark'] as const

type Theme = (typeof themes)[number]

function parseColor(color: string) {
  // Chromium can serialize a resolved color as color(srgb r g b / a), where the
  // channels are 0–1 rather than 0–255. Normalize that form before the generic
  // rgb()/rgba() parser so contrast assertions cannot silently compare 1 with 255.
  const srgb = color.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/)
  if (srgb) {
    const [, r, g, b, alpha] = srgb
    let parsedAlpha = 1
    if (alpha !== undefined) {
      parsedAlpha = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)
    }
    return {
      r: Number(r) * 255,
      g: Number(g) * 255,
      b: Number(b) * 255,
      a: parsedAlpha,
    }
  }
  const channels = color.match(/[\d.]+/g)?.map(Number)
  if (!channels || channels.length < 3) throw new Error(`Unexpected computed color: ${color}`)
  const [r, g, b, a = 1] = channels
  return { r, g, b, a }
}

function composite(foreground: string, background: string): string {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  const alpha = fg.a
  return `rgb(${Math.round(fg.r * alpha + bg.r * (1 - alpha))}, ${Math.round(
    fg.g * alpha + bg.g * (1 - alpha)
  )}, ${Math.round(fg.b * alpha + bg.b * (1 - alpha))})`
}

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

  const foregroundLuminance = luminance(composite(foreground, background))
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
        if (viewport.name === 'mobile') await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
        await expect(page.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
        await expect(page.getByLabel('企业邮箱')).toBeVisible()
        await expect(page.getByLabel('登录密码')).toBeVisible()

        const colors = await page.locator('.login-slab').evaluate((slab) => {
          const entry = document.querySelector('.login-entry') as HTMLElement
          const brandPanel = document.querySelector('.brand-panel') as HTMLElement
          const formPanel = document.querySelector('.form-panel') as HTMLElement
          const style = (node: Element) => window.getComputedStyle(node)
          const input = formPanel.querySelector('input') as HTMLInputElement
          return {
            stage: style(entry).backgroundColor,
            slab: style(slab).backgroundColor,
            radius: style(slab).borderRadius,
            backdrop: style(slab).backdropFilter,
            heading: style(brandPanel.querySelector('h1')!).color,
            copy: style(brandPanel.querySelector('p')!).color,
            formHeading: style(formPanel.querySelector('h2')!).color,
            formCopy: style(formPanel.querySelector('.form-heading p')!).color,
            inputBg: style(input).backgroundColor,
            placeholder: window.getComputedStyle(input, '::placeholder').color,
          }
        })
        const slabBackground = composite(colors.slab, colors.stage)
        expect(colors.stage).toBe(theme === 'light' ? 'rgb(232, 234, 228)' : 'rgb(28, 29, 29)')
        expect(colors.radius).toBe(viewport.name === 'mobile' ? '20px' : '24px')
        expect(colors.backdrop).toContain('blur')
        for (const foreground of [colors.heading, colors.copy, colors.formHeading, colors.formCopy]) {
          expect(getContrastRatio(foreground, slabBackground)).toBeGreaterThanOrEqual(4.5)
        }
        const inputBackground = composite(colors.inputBg, slabBackground)
        expect(getContrastRatio(colors.placeholder, inputBackground)).toBeGreaterThanOrEqual(4.5)

        const placeholders = await page.locator('input').evaluateAll((inputs) => inputs.map((input) => {
          const style = window.getComputedStyle(input)
          const placeholder = window.getComputedStyle(input, '::placeholder')
          return { foreground: placeholder.color, background: style.backgroundColor }
        }))
        for (const colors of placeholders) {
          expect(getContrastRatio(colors.foreground, composite(colors.background, slabBackground))).toBeGreaterThanOrEqual(4.5)
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
    const loginEntry = page.locator('.login-entry')
    const themeToggle = page.getByRole('button', { name: /切换到深色模式/ })

    await setTheme(page, 'light')
    await expect(loginEntry).toHaveCSS('background-color', 'rgb(232, 234, 228)')
    await expect(loginEntry).toHaveCSS('color-scheme', 'light')
    await expect(themeToggle).toBeVisible()
    await themeToggle.click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(loginEntry).toHaveCSS('background-color', 'rgb(28, 29, 29)')
    await expect(loginEntry).toHaveCSS('color-scheme', 'dark')
    await page.locator('.theme-button').click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(loginEntry).toHaveCSS('background-color', 'rgb(232, 234, 228)')
    await expect(loginEntry).toHaveCSS('color-scheme', 'light')
  })

  test('keyboard focus uses the Warm Ledger rounded control scale', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')

    await page.getByLabel('企业邮箱').focus()
    await expect(page.getByLabel('企业邮箱')).toHaveCSS('border-radius', '10px')
    await page.getByRole('button', { name: '显示密码' }).focus()
    await expect(page.getByRole('button', { name: '显示密码' })).toHaveCSS('border-radius', '0px 10px 10px 0px')
    await page.getByRole('button', { name: /登录工作区/ }).focus()
    await expect(page.getByRole('button', { name: /登录工作区/ })).toHaveCSS('border-radius', '10px')
  })

  test('hovering an input produces no motion and no layout shift', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')

    for (const label of ['企业邮箱', '登录密码']) {
      const input = page.getByLabel(label)
      const before = await input.boundingBox()
      await input.hover()
      await page.waitForTimeout(320)
      expect(await input.evaluate((element) => window.getComputedStyle(element).transform)).toBe('none')
      expect(await input.evaluate((element) => window.getComputedStyle(element).transitionProperty)).not.toContain(
        'transform'
      )
      const after = await input.boundingBox()
      expect(after).toEqual(before)
    }
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
