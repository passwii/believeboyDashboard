import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-615 运营域 C 手机端适配回归（site-navigation / store-navigation）。
 *
 * 自包含：session 与后端请求经 page.route mock，不依赖真实后端 / 登录态。
 * 默认随 mobile project（Pixel 5，393×851）跑；另加 360×800 小屏用例覆盖验收下界；
 * 桌面零回归用例在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 总则 1：导航卡手机端一行两个（grid-cols-2 基础列数），不挤压、不溢出；
 * - 总则 5：区块标题行手机端纵向堆叠；
 * - 规则 6：空态（store 无数据时图标 + 文案居中）；
 * - 页面无整体横向滚动（两页均无表格，规则 10 N/A）。
 */

const FIXTURE_SECRET = BLF611_FIXTURE_SECRET

async function forgeSessionToken(): Promise<string> {
  return encode({
    token: {
      uid: '1',
      isAdmin: true,
      roleType: 'admin',
      // BLF-1441：会话显示名唯一来源是 full_name（不再回落运营名 / 登录名）
      fullName: 'E2E',
      operatorNameZh: 'E2E',
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

const SESSION = {
  user: { id: '1', name: 'E2E', email: 'e2e@example.com', roleType: 'admin', fullName: '测试', operatorNameZh: '测试' },
  expires: '2099-01-01T00:00:00.000Z',
}

/** 模拟 fetchManagedProjectsCached 返回的店铺数据（含长名称 / 无链接店铺验证布局兜底） */
const STORES = [
  {
    id: 1,
    name: 'Amazon 美国站主店铺',
    brand_name: 'BELIEVEBOY',
    store_address: 'https://www.amazon.com/stores/example',
  },
  {
    id: 2,
    name: 'SHEIN 旗舰店',
    brand_name: null,
    store_address: 'https://us.shein.com',
  },
  {
    id: 3,
    name: 'Walmart Marketplace 店铺',
    brand_name: 'BELIEVEBOY',
    store_address: 'https://www.walmart.com/shop/example',
  },
  {
    id: 4,
    name: 'TEMU 官方店',
    brand_name: null,
    store_address: 'https://www.temu.com',
  },
  {
    id: 5,
    name: '未配置链接的示例店铺（用于验证无链接卡片布局）',
    brand_name: 'NO-LINK',
    store_address: null,
  },
  {
    id: 6,
    name: 'TikTok Shop 店铺',
    brand_name: 'BELIEVEBOY',
    store_address: 'https://www.tiktok.com/shop',
  },
]

async function mockStoreBackend(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: SESSION }))
  await page.route('**/api/backend-base**', (route) => route.fulfill({ json: { base_url: '' } }))
  await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
    route.fulfill({ json: STORES })
  )
}

/** 页面级无整体横向滚动（允许 ±2px 误差） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    // 排除“预期内 scrollWidth > clientWidth”的容器，避免误报：
    // 1. 自身就是 overflow-x-auto/overflow-auto 的表格横滑容器（规则 10）；
    // 2. 含 overflow-x-auto 后代的 dashboard-surface（overflow-hidden 裁剪表格）；
    // 3. truncate 文本省略号 span（overflow-hidden + text-overflow: ellipsis）；
    // 4. 溢出仅由绝对定位装饰元素（视觉出血，如导航卡右上 blur 光斑）造成的 overflow-hidden
    //    容器 —— 其内容本就被 overflow-hidden 裁剪，不产生页面级横向滚动（BLF-615）。
    const overflowHidden = Array.from(
      document.querySelectorAll('[class*="overflow-hidden"]')
    ).filter((el) => {
      const cls = String(el.className)
      if (/overflow-x-auto|overflow-auto|truncate/.test(cls)) return false
      if (el.querySelector('[class*="overflow-x-auto"], [class*="overflow-auto"]')) return false
      const rect = el.getBoundingClientRect()
      if (el.scrollWidth - el.clientWidth > 2) {
        // 溢出仅由绝对定位子元素（装饰出血）造成 → 预期裁剪，不算违规
        const overflowers = Array.from(el.querySelectorAll('*')).filter((child) => {
          const cr = child.getBoundingClientRect()
          return cr.right > rect.right + 1 || cr.bottom > rect.bottom + 1
        })
        if (overflowers.length > 0) {
          const allAbsolute = overflowers.every((child) => {
            const pos = getComputedStyle(child).position
            return pos === 'absolute' || pos === 'fixed'
          })
          if (allAbsolute) return false
        }
      }
      return true
    })
    const candidates: Element[] = [document.documentElement, document.body, ...overflowHidden]
    const main = document.querySelector('#main-content')
    if (main) candidates.push(main)
    return candidates
      .filter((el) => el.scrollWidth - el.clientWidth > 2)
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className).slice(0, 160),
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }))
  })
  if (offenders.length > 0) {
    console.log('OVERFLOW_OFFENDERS=' + JSON.stringify(offenders))
  }
  expect(offenders.length, '页面级容器不应出现横向溢出（表格内部横滑除外）').toBe(0)
}

/** 主内容区内第一、第二张导航卡同一行（手机端一行两个） */
async function expectFirstTwoCardsSameRow(page: import('@playwright/test').Page) {
  const cards = page.locator('#main-content a[target="_blank"]')
  await expect(cards.first()).toBeVisible({ timeout: 30000 })
  const first = (await cards.nth(0).boundingBox())!
  const second = (await cards.nth(1).boundingBox())!
  expect(Math.abs(first.y - second.y), '第一、二张卡应在同一行（一行两个）').toBeLessThan(2)
  const viewport = page.viewportSize()!
  expect(first.width, '手机端单卡宽度不应超过视口 70%').toBeLessThan(viewport.width * 0.7)
  return { first, second }
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'operations-mobile-blf615 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
  await mockStoreBackend(page)
  await context.addCookies([
    {
      name: 'authjs.session-token',
      value: await forgeSessionToken(),
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
})

test.describe('@mobile-blf615 站点导航 手机端（BLF-615）', () => {
  test('导航卡一行两个 + 区块标题纵向堆叠 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/site-navigation')

    // 平台区块：一行两个
    await expect(page.getByRole('heading', { name: '平台' })).toBeVisible({ timeout: 30000 })
    const { first } = await expectFirstTwoCardsSameRow(page)
    // 资讯论坛区块：同样一行两个（站点 7 平台中 6 平台 + 1 论坛 → 论坛区 1 张卡，单列属预期）
    const forumCards = page.locator('#main-content a[target="_blank"]')
    await expect(forumCards).toHaveCount(7)
    const headingBox = (await page.getByRole('heading', { name: '平台' }).boundingBox())!
    expect(headingBox.y).toBeLessThan(first.y)

    await expectNoPageHorizontalOverflow(page)
  })

  test('360×800 小屏：导航卡仍一行两个，无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/operations/site-navigation')

    await expect(page.getByRole('heading', { name: '平台' })).toBeVisible({ timeout: 30000 })
    await expectFirstTwoCardsSameRow(page)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf615 店铺导航 手机端（BLF-615）', () => {
  test('店铺卡一行两个 + 无链接店铺正常渲染 + 页面无横向滚动', async ({ page }) => {
    await page.goto('/dashboard/operations/store-navigation')

    await expect(page.getByRole('heading', { name: '全部店铺' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('店铺总数')).toBeVisible({ timeout: 30000 })
    await expectFirstTwoCardsSameRow(page)

    // 无链接店铺卡片：渲染且文案为「暂无店铺链接」
    await expect(page.getByText('暂无店铺链接')).toBeVisible()
    // 长名称店铺卡在 2 列布局内不撑破页面
    await expect(page.getByText('未配置链接的示例店铺（用于验证无链接卡片布局）')).toBeVisible()

    await expectNoPageHorizontalOverflow(page)
  })

  test('空态：无店铺数据时图标 + 文案居中', async ({ page }) => {
    await page.route('**/api/backend/api/v1/projects/manage**', (route) =>
      route.fulfill({ json: [] })
    )
    await page.goto('/dashboard/operations/store-navigation')

    await expect(page.getByText('暂无店铺数据')).toBeVisible({ timeout: 30000 })
    const emptyBox = (await page.getByText('暂无店铺数据').boundingBox())!
    expect(emptyBox.x).toBeGreaterThan(50) // 居中（远离左边缘）
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf615 桌面零回归（BLF-615）', () => {
  test('1440：站点导航首行四卡同行（xl:grid-cols-4），店铺导航同理', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/dashboard/operations/site-navigation')
    await expect(page.getByRole('heading', { name: '平台' })).toBeVisible({ timeout: 30000 })
    const siteCards = page.locator('#main-content a[target="_blank"]')
    await expect(siteCards).toHaveCount(7)
    const s0 = (await siteCards.nth(0).boundingBox())!
    const s3 = (await siteCards.nth(3).boundingBox())!
    expect(Math.abs(s0.y - s3.y), '1440 桌面首行应 4 卡同行').toBeLessThan(2)

    await page.goto('/dashboard/operations/store-navigation')
    await expect(page.getByRole('heading', { name: '全部店铺' })).toBeVisible({ timeout: 30000 })
    const storeCards = page.locator('#main-content a[target="_blank"]')
    await expect(storeCards).toHaveCount(6)
    const t0 = (await storeCards.nth(0).boundingBox())!
    const t3 = (await storeCards.nth(3).boundingBox())!
    expect(Math.abs(t0.y - t3.y), '1440 桌面首行应 4 卡同行').toBeLessThan(2)
  })
})
