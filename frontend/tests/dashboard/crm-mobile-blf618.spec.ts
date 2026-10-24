import { test, expect } from '@playwright/test'
import { encode } from 'next-auth/jwt'

import { BLF611_FIXTURE_SECRET } from '../setup/blf611-fixture'

/**
 * BLF-618 CRM 域手机端适配回归（customers / leads / sea / follow-ups / tasks / dashboard / audit）。
 *
 * 自包含：CRM 客户端默认走 MockCrmClient（NEXT_PUBLIC_CRM_API_MODE 未设置 → mock），
 * 页面无需 mock 后端接口；仅伪造 admin session 通过 proxy 鉴权。
 * 默认随 mobile project（Pixel 5，393×851）跑；另加 360×800 小屏用例；桌面零回归
 * 在测试内切 1440×900。
 *
 * 覆盖验收（MOBILE_ADAPTATION_RULES.md，BLF-610 版）：
 * - 规则 2/8：crm-table / task-list / audit 筛选区手机端 2 列网格；
 * - 规则 10：多列表格容器内横滑（min-width: max-content），页面无整体横向滚动；
 * - 规则 5：分页按钮触摸目标 ≥44px；
 * - 总则 1：dashboard StatCardRow 手机端一行两个；
 * - 详情抽屉 TabsList 手机端 3 列×2 行，无挤压溢出；
 * - 桌面 1440 零回归（筛选区恢复横向 flex）。
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
      sessionId: 'e2e-session',
      name: 'E2E',
      email: 'e2e@example.com',
      sub: '1',
    },
    secret: FIXTURE_SECRET,
    salt: 'authjs.session-token',
  })
}

/** 页面级无整体横向滚动（允许 ±2px 误差；表格横滑容器属预期，排除在外） */
async function expectNoPageHorizontalOverflow(page: import('@playwright/test').Page) {
  const offenders = await page.evaluate(() => {
    const overflowHidden = Array.from(
      document.querySelectorAll('[class*="overflow-hidden"]')
    ).filter((el) => {
      const cls = String(el.className)
      if (/overflow-x-auto|overflow-auto|truncate/.test(cls)) return false
      if (el.querySelector('[class*="overflow-x-auto"], [class*="overflow-auto"]')) return false
      // overflow-hidden 容器的内容被自身裁剪，不产生页面级横向滚动（如漏斗转化率
      // 进度条：内条 width 可 >100% 但被轨道裁剪，sw>cw 属预期）。仅当容器自己的
      // 盒子超出视口时才是真正的页面级溢出（BLF-618 收敛，替代原 allAbsolute 判定）。
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      if (rect.left >= -1 && rect.right <= vw + 1) return false
      return el.scrollWidth - el.clientWidth > 2
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

/** 断言两个元素处于同一行（y 差 < 2px） */
async function expectSameRow(
  page: import('@playwright/test').Page,
  a: import('@playwright/test').Locator,
  b: import('@playwright/test').Locator,
  label: string
) {
  const ba = (await a.boundingBox())!
  const bb = (await b.boundingBox())!
  expect(Math.abs(ba.y - bb.y), label).toBeLessThan(2)
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'crm-mobile-blf618 仅在 mobile project 运行（断言依赖手机端视口）'
  )
})

test.beforeEach(async ({ page, context }) => {
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

test.describe('@mobile-blf618 CRM 客户管理 手机端（BLF-618）', () => {
  test('筛选 2 列网格 + 表格横滑不折行 + 分页 44px + 详情抽屉 3 列 Tab', async ({ page }) => {
    await page.goto('/dashboard/crm/customers')

    // 表头（PageHeader）渲染
    await expect(page.getByRole('heading', { name: '客户管理' })).toBeVisible({ timeout: 30000 })
    // 表格数据渲染（mock 100 客户，pageSize 20）
    await expect(page.getByText('共 100 条')).toBeVisible({ timeout: 30000 })

    // 规则 2/8：筛选区手机端 2 列网格 —— 状态/等级同一行，对象类型换行到第二行
    const statusSelect = page.getByLabel('状态')
    const ratingSelect = page.getByLabel('等级')
    const typeSelect = page.getByLabel('对象类型')
    await expect(statusSelect).toBeVisible()
    await expectSameRow(page, statusSelect, ratingSelect, '状态/等级筛选应同一行（2 列网格）')
    const statusBox = (await statusSelect.boundingBox())!
    const typeBox = (await typeSelect.boundingBox())!
    expect(typeBox.y, '对象类型筛选应换行到第二行').toBeGreaterThan(statusBox.y + 4)

    // 搜索框手机端全宽（接近容器宽度）
    const searchBox = (await page.getByPlaceholder('搜索客户名 / 简称…').boundingBox())!
    expect(searchBox.width, '搜索框手机端应接近全宽').toBeGreaterThan(300)

    // 规则 5：分页按钮触摸目标 ≥44px
    const firstPageBtn = page.getByRole('button', { name: '首页' })
    await expect(firstPageBtn).toBeVisible()
    const btnBox = (await firstPageBtn.boundingBox())!
    expect(btnBox.height, '分页按钮高度 ≥44px').toBeGreaterThanOrEqual(44)

    // 规则 10：表格容器内横滑（表格宽度 > 可视宽度），页面无整体横向溢出
    const table = page.locator('#main-content table').first()
    const tableBox = (await table.boundingBox())!
    const viewport = page.viewportSize()!
    expect(tableBox.width, '表格应超出手机视口宽度（容器内横滑）').toBeGreaterThan(viewport.width * 0.9)
    await expectNoPageHorizontalOverflow(page)

    // 详情抽屉：TabsList 手机端 3 列×2 行（详情/跟进/联系人 第 1 行，任务/操作记录/编辑 第 2 行）
    await page.locator('#main-content tbody tr').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15000 })
    // 注：headless Chromium 下 sheet 滑入动画可能停滞（软件渲染伪影，headed 实测正常），
    // 故不等待动画到位，改为相对抽屉容器断言（验收标准 = tab 不超出抽屉，而非视口）。
    await page.waitForTimeout(500)
    await expectSameRow(
      page,
      page.getByRole('tab', { name: '详情' }),
      page.getByRole('tab', { name: '联系人' }),
      '详情/联系人 Tab 应同一行（3 列网格）'
    )
    const detailBox = (await page.getByRole('tab', { name: '详情' }).boundingBox())!
    const tasksTabBox = (await page.getByRole('tab', { name: '任务' }).boundingBox())!
    expect(tasksTabBox.y, '任务 Tab 应换行到第二行').toBeGreaterThan(detailBox.y + 4)
    // 「操作记录」Tab 完整位于抽屉容器内（不超出抽屉右边界）
    const auditTabBox = (await page.getByRole('tab', { name: '操作记录' }).boundingBox())!
    const sheetBox = (await dialog.boundingBox())!
    expect(
      auditTabBox.x + auditTabBox.width,
      '操作记录 Tab 右缘不超出抽屉容器'
    ).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 1)
    expect(auditTabBox.x, '操作记录 Tab 左缘在抽屉容器内').toBeGreaterThanOrEqual(sheetBox.x - 1)
  })

  test('360×800 小屏：筛选 2 列 + 无整体横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/dashboard/crm/customers')

    await expect(page.getByText('共 100 条')).toBeVisible({ timeout: 30000 })
    await expectSameRow(page, page.getByLabel('状态'), page.getByLabel('等级'), '360px 下状态/等级仍同一行')
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf618 CRM 线索 / 公海 / 待跟进 手机端（BLF-618）', () => {
  test('线索页：筛选 2 列 + 表格横滑 + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/leads')
    await expect(page.getByRole('heading', { name: '线索管理' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('共 50 条')).toBeVisible({ timeout: 30000 })

    await expectSameRow(page, page.getByLabel('状态'), page.getByLabel('意向度'), '线索筛选状态/意向度同一行')
    await expectNoPageHorizontalOverflow(page)
  })

  test('公海页：表格横滑 + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/sea')
    await expect(page.getByRole('heading', { name: '客户公海' })).toBeVisible({ timeout: 30000 })
    // 公海数据或空态二选一，均不应溢出
    await expectNoPageHorizontalOverflow(page)
  })

  test('待跟进页：无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/follow-ups')
    await expect(page.getByRole('heading', { name: '待跟进' })).toBeVisible({ timeout: 30000 })
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf618 CRM 任务 手机端（BLF-618）', () => {
  test('列表视图：筛选 2 列网格 + 原生表格横滑 + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/tasks')
    await expect(page.getByRole('heading', { name: '任务' })).toBeVisible({ timeout: 30000 })

    // 切换到列表视图
    await page.getByTestId('view-list').click()
    await expect(page.getByTestId('task-list-create')).toBeVisible({ timeout: 15000 })

    // 规则 2/8：筛选 2 列网格 —— 类型/状态同一行
    await expectSameRow(page, page.getByLabel('类型', { exact: true }), page.getByLabel('状态', { exact: true }), '任务筛选类型/状态同一行')
    // 新建任务按钮占满一行（col-span-2）
    const createBtnBox = (await page.getByTestId('task-list-create').boundingBox())!
    const viewport = page.viewportSize()!
    expect(createBtnBox.width, '新建任务按钮手机端应接近全宽').toBeGreaterThan(viewport.width * 0.8)

    // 规则 10：原生 table（min-w-[840px]）容器内横滑
    const table = page.locator('#main-content table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    const tableBox = (await table.boundingBox())!
    expect(tableBox.width, '任务表格应超出手机视口宽度（容器内横滑）').toBeGreaterThan(viewport.width * 0.9)
    await expectNoPageHorizontalOverflow(page)
  })

  test('看板视图：单列堆叠 + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/tasks')
    await expect(page.getByRole('heading', { name: '任务' })).toBeVisible({ timeout: 30000 })
    // 手机端看板 grid-cols-1：三列纵向堆叠
    const pendingBox = (await page.getByTestId('task-column-pending').boundingBox())!
    const doneBox = (await page.getByTestId('task-column-done').boundingBox())!
    expect(doneBox.y, '看板三列手机端应纵向堆叠').toBeGreaterThan(pendingBox.y + 4)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf618 CRM 数据看板 / 操作日志 手机端（BLF-618）', () => {
  test('数据看板：两图层揭示遵守 reduced-motion、主题和响应式布局', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dashboard/crm/dashboard?e2e')
    await expect(page.getByText('本月新增客户')).toBeVisible({ timeout: 30000 })

    const kpis = page.locator('[data-testid="crm-dashboard-kpis"]')
    const funnel = page.locator('[data-testid="crm-dashboard-funnel"]')
    await expect(kpis).toHaveAttribute('data-state', 'revealed', { timeout: 15000 })
    await expect(funnel).toHaveAttribute('data-state', 'revealed', { timeout: 15000 })
    await expect(kpis.locator('.ui-skel-content')).not.toHaveAttribute('aria-hidden')
    await expect(kpis.locator('.ui-skel-content')).not.toHaveAttribute('inert')
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="crm-dashboard-kpis"]')
      const content = root?.querySelector<HTMLElement>('.ui-skel-content')
      return Boolean(content && !content.hasAttribute('inert') && getComputedStyle(content).opacity === '1')
    })

    const motion = await kpis.locator('.ui-skel-content').evaluate((content) => ({
      transitionDuration: getComputedStyle(content).transitionDuration,
      pulseAnimation: getComputedStyle(content.parentElement!.querySelector('.ui-skel-skeleton')!.firstElementChild!).animationName,
    }))
    expect(motion.transitionDuration).toBe('0s')
    expect(motion.pulseAnimation).toBe('none')

    const themeColors = await page.evaluate(() => {
      const root = document.documentElement
      const bar = root.querySelector<HTMLElement>('[data-testid="crm-dashboard-kpis"] .ui-skel-skeleton .h-3')!
      root.classList.remove('dark')
      const light = getComputedStyle(bar).backgroundColor
      root.classList.add('dark')
      const dark = getComputedStyle(bar).backgroundColor
      root.classList.remove('dark')
      return { light, dark }
    })
    expect(themeColors.light).not.toBe(themeColors.dark)

    for (const width of [393, 360]) {
      await page.setViewportSize({ width, height: 851 })
      await expectSameRow(page, page.getByText('本月新增客户'), page.getByText('本月新增线索'), `${width}px KPI 一行两个`)
      const firstKpi = (await page.getByText('本月新增客户').boundingBox())!
      const thirdKpi = (await page.getByText('本月转化', { exact: true }).first().boundingBox())!
      expect(thirdKpi.y, `${width}px 第 3 个 KPI 应换行到第二行`).toBeGreaterThan(firstKpi.y + 4)
      await expectNoPageHorizontalOverflow(page)
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    await expectSameRow(page, page.getByText('本月新增客户'), page.getByText('本月转化', { exact: true }).first(), '1440px KPI 四列同一行')
    await expectNoPageHorizontalOverflow(page)
  })

  test('操作日志：筛选 2 列网格 + 分页 44px + 无溢出', async ({ page }) => {
    await page.goto('/dashboard/crm/audit')
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible({ timeout: 30000 })

    // 对象 / 操作 两个筛选同一行（2 列网格）
    await expectSameRow(
      page,
      page.getByText('对象', { exact: true }).first(),
      page.getByText('操作', { exact: true }).first(),
      '操作日志筛选对象/操作同一行'
    )
    // 分页按钮触摸目标
    const prevBtn = page.getByRole('button', { name: '上一页' })
    await expect(prevBtn).toBeVisible()
    const btnBox = (await prevBtn.boundingBox())!
    expect(btnBox.height, '分页按钮高度 ≥44px').toBeGreaterThanOrEqual(44)
    await expectNoPageHorizontalOverflow(page)
  })
})

test.describe('@mobile-blf618 CRM 桌面零回归（BLF-618）', () => {
  test('1440：筛选区恢复横向 flex（状态/对象类型同处一行）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard/crm/customers')

    await expect(page.getByText('共 100 条')).toBeVisible({ timeout: 30000 })
    // 桌面 md+：筛选横向排列 —— 状态/对象类型（第 3 个筛选）同一行
    await expectSameRow(
      page,
      page.getByLabel('状态'),
      page.getByLabel('对象类型'),
      '1440 桌面筛选应横向排列（同一行）'
    )
    await expectNoPageHorizontalOverflow(page)
  })
})
