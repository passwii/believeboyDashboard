/**
 * BLF-1075 · dashboard 左侧 L1 Rail 顶部 logo 几何回归
 * —— 正方形 logo 必须「完全占用左上角的正方形」，四周无留白。
 *    旧实现 `h-10 w-10` + 容器 `items-center justify-center`：在 64×56 的格子里
 *    留出 11.5px（左右）与 7.5px（上下）空白；现改为 `h-full w-full` + 容器去居中，
 *    logo 与格子内容区（= 格子尺寸 − 1px 面板分割线）完全等大。
 * 自包含：伪造 session cookie，无需真实后端。
 *
 * Run: PLAYWRIGHT_PORT=<port> pnpm test:ui tests/design/blf1075-rail-logo.spec.ts --project=chromium
 * 截图输出：frontend/test-results/blf1075/*.png
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'
import path from 'node:path'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

const OUT_DIR = path.join(__dirname, '../../test-results/blf1075')

/** 顶部基准带高度（= TERMINAL_HEADER_HEIGHT，BLF-832/887）；与 terminal-constants.ts 同源 */
const TOP_STRIP_HEIGHT = 56
/** L1 Rail 宽度（TERMINAL_RAIL_WIDTH） */
const RAIL_WIDTH = 64

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      operatorNameZh: 'E2E',
      sessionId: 'blf1075',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: BLF611_FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

async function signIn(page: Page) {
  await page.context().addCookies([
    {
      name: 'authjs.session-token',
      value: await forgeSessionToken(),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

/** 量取 logo 与它所在格子的几何关系 */
async function measureLogo(page: Page) {
  const logo = page.getByTestId('terminal-rail-logo')
  await expect(logo).toBeVisible({ timeout: 30_000 })
  return logo.evaluate((el) => {
    const aside = el.closest('aside')!
    const slot = el.parentElement!
    const a = aside.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    return {
      railWidth: a.width,
      railLeft: a.left,
      railTop: a.top,
      slotHeight: s.height,
      // 格子内容区＝格子尺寸 − 分割线边框；logo 与它等大才算「零留白」
      slotClientWidth: slot.clientWidth,
      slotClientHeight: slot.clientHeight,
      padding: getComputedStyle(slot).padding,
      margin: getComputedStyle(el).margin,
      box: { x: b.x, y: b.y, width: b.width, height: b.height },
      gaps: {
        left: b.left - s.left,
        top: b.top - s.top,
        right: s.right - b.right,
        bottom: s.bottom - b.bottom,
      },
    }
  })
}

test.describe('@design BLF-1075 Rail logo 满格', () => {
  test('logo 完全贴合左上角方块、无留白（含分割线外的零间隙）', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    const m = await measureLogo(page)
    console.log('BLF1075_MEASURED=' + JSON.stringify(m))

    // 格子 = Rail 宽度 × 顶部基准带高度
    expect(m.railWidth).toBe(RAIL_WIDTH)
    expect(m.slotHeight).toBe(TOP_STRIP_HEIGHT)

    // 无 padding / margin —— 留白只可能来自间距，不可能来自分割线
    expect(m.padding).toBe('0px')
    expect(m.margin).toBe('0px')

    // logo 与格子内容区完全等大（撑满整格）
    expect(Math.abs(m.box.width - m.slotClientWidth)).toBeLessThan(0.5)
    expect(Math.abs(m.box.height - m.slotClientHeight)).toBeLessThan(0.5)

    // 贴合面板左上角（无偏移）
    expect(Math.abs(m.box.x - m.railLeft)).toBeLessThan(0.5)
    expect(Math.abs(m.box.y - m.railTop)).toBeLessThan(0.5)

    // 四边空隙 ≤ 1px：右/下各 1px 是必须保留的面板分割线（BLF-832 四列基准线贯通），
    // 左/上为 0；旧实现此处是 11.5px / 7.5px 的实际留白。
    expect(m.gaps.left).toBe(0)
    expect(m.gaps.top).toBe(0)
    expect(m.gaps.right).toBeLessThanOrEqual(1)
    expect(m.gaps.bottom).toBeLessThanOrEqual(1)
    // 必须小于旧实现的留白，锁定「确已铺满」而非碰巧通过
    expect(m.gaps.right, '右侧留白须远小于旧 h-10 居中实现的 11.5px').toBeLessThan(2)
    expect(m.gaps.bottom, '下方留白须远小于旧 h-10 居中实现的 7.5px').toBeLessThan(2)

    await page.screenshot({
      path: path.join(OUT_DIR, 'rail-logo-light-1440.png'),
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
  })

  test('满格后键盘焦点仍可感知（同色描边会被自身底色吞掉）', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    // logo 现在自身就是 accent 蓝底；若焦点环也用 accent，环与底色同色 → 焦点不可见
    const logo = page.getByTestId('terminal-rail-logo')
    await logo.focus()
    const ring = await logo.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        boxShadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        background: cs.backgroundColor,
      }
    })
    console.log('BLF1075_FOCUS=' + JSON.stringify(ring))

    // 必须存在可见的焦点指示：outline 或 ring(box-shadow)
    const hasOutline = ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) > 0
    const hasRing = /rgb/.test(ring.boxShadow) && !/rgba\(0, 0, 0, 0\)/.test(ring.boxShadow)
    expect(hasOutline || hasRing, '焦点指示不可丢失（否则纯键盘用户看不到当前位置）').toBe(true)
  })

  test('暗色主题下同样满格（无主题相关留白回退）', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
    await signIn(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    const m = await measureLogo(page)
    expect(m.padding).toBe('0px')
    expect(Math.abs(m.box.width - m.slotClientWidth)).toBeLessThan(0.5)
    expect(Math.abs(m.box.height - m.slotClientHeight)).toBeLessThan(0.5)
    expect(m.gaps.left).toBe(0)
    expect(m.gaps.top).toBe(0)
    expect(m.gaps.right).toBeLessThanOrEqual(1)
    expect(m.gaps.bottom).toBeLessThanOrEqual(1)

    // 暗色主题分割线外的格子里确实是「暗色下仍发光的 accent 底」，不是背景色漏白
    const isAccentBlock = await page.getByTestId('terminal-rail-logo').evaluate((el) => {
      const bg = getComputedStyle(el).backgroundColor
      const m2 = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!m2) return false
      const [r, g, b] = [Number(m2[1]), Number(m2[2]), Number(m2[3])]
      // 蓝色分量须显著高于红/绿（accent 蓝），而非接近灰白背景；
      // g > r 同时排除「灰白/近白」这种 r≈g≈b 的中性色
      return b > 150 && b - r > 40 && g > r
    })
    expect(isAccentBlock, 'logo 块应为 accent 蓝色底').toBe(true)

    await page.screenshot({
      path: path.join(OUT_DIR, 'rail-logo-dark-1440.png'),
      clip: { x: 0, y: 0, width: 300, height: 200 },
    })
  })

  test('折叠 L2 SubNav 后 logo 仍满格、顶部基准线不错位', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')

    const before = await measureLogo(page)

    // Header 的 PanelLeft 是 L2 折叠唯一入口（BLF-907）
    const toggle = page.getByRole('button', { name: /折叠|展开|子导航|subnav/i }).first()
    if (await toggle.count()) await toggle.click()

    const after = await measureLogo(page)
    expect(after.slotHeight, '折叠不影响顶部基准带高度').toBe(TOP_STRIP_HEIGHT)
    expect(Math.abs(after.box.height - after.slotClientHeight)).toBeLessThan(0.5)
    expect(Math.abs(after.box.width - after.slotClientWidth)).toBeLessThan(0.5)
    expect(after.gaps.left).toBe(0)
    expect(after.gaps.top).toBe(0)
    // logo 尺寸不因折叠变化
    expect(Math.abs(after.box.width - before.box.width)).toBeLessThan(0.5)
    expect(Math.abs(after.box.height - before.box.height)).toBeLessThan(0.5)
  })
})
