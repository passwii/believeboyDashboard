/**
 * Page-level render test for the inventory-replenishment page (BLF-629).
 *
 * BLF-629 回归锁：第一个 card「分析控制台」第 2 段（FilterToolbar 筛选条）的
 * 4 个字段在桌面（md+）必须是横排。根因是字段外层 wrapper 的 `w-full` 在
 * FilterToolbar 的桌面 `md:flex md:flex-wrap` 容器里占满整行，导致每个字段
 * 各自换行竖排；修复是 wrapper 加 `md:w-auto`，让桌面按内容宽度横排。
 *
 * 这里锁定 DOM 契约：4 个 wrapper 都带 `md:w-auto`（+ 各自期望的 md 宽度），
 * 防止有人把 wrapper 改回纯 `w-full` 造成回归。手机端 2 列网格仍由 `w-full`
 * 撑满，不受影响。
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── next/navigation：进程内 URL search param 存储 ────────────────────────────
const nav = vi.hoisted(() => {
  let params = new URLSearchParams('project=1&country=US')
  return {
    setParams(qs: string) {
      params = new URLSearchParams(qs)
    },
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    replace: (url: string) => {
      const qs = url.includes('?') ? (url.split('?')[1] ?? '') : ''
      params = new URLSearchParams(qs)
    },
  }
})

// BLF-450 教训：mock 返回值必须是模块级稳定引用（每次 render 新对象会触发
// effect 无限重跑、loading 振荡——本项目 project cache / ops cache 的 effect
// 依赖 session / notify 的引用恒等）。
const mockSession = vi.hoisted(() => ({
  data: { user: { name: '测试用户' } },
  status: 'authenticated',
}))
const mockNotify = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
  usePathname: () => '/dashboard/operations/inventory-replenishment',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}))

// 模块级常量：避免每次 render 新引用触发 effect 无限重跑、loading 振荡
const PROJECTS = [{ id: 1, name: '项目A' }]

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: () => Promise.resolve(PROJECTS),
}))

const EMPTY_ANALYSIS = {
  items: [],
  summary: {
    sku_count: 0,
    out_of_stock_risk_count: 0,
    healthy_count: 0,
    slow_moving_count: 0,
    pending_data_count: 0,
    total_available_inventory: 0,
    total_in_transit_quantity: 0,
    critical_count: 0,
    deteriorating_count: 0,
    watch_count: 0,
    healthy_count_v2: 0,
    unknown_count: 0,
  },
  page: 1,
  page_size: 200,
  total: 0,
  has_next: false,
}

vi.mock('@/lib/ops-client-cache', () => ({
  fetchOpsJsonCached: () => Promise.resolve(EMPTY_ANALYSIS),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))

// 日历视图走 next/dynamic + recharts；jsdom 下用 stub 替身
vi.mock('next/dynamic', () => ({
  default: () =>
    function LazyCalendarStub() {
      return <div data-testid="calendar-stub" />
    },
}))

import InventoryReplenishmentPage from './inventory-replenishment-client'

beforeEach(() => {
  nav.setParams('project=1&country=US')
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    )
  )
})

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('补货分析页 FilterToolbar 筛选条（BLF-629）', () => {
  it('渲染 4 个筛选字段（项目 / 关键词 / 国家 / 风险状态）', async () => {
    render(<InventoryReplenishmentPage />)
    await waitFor(() => expect(screen.getByText('项目A')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('搜索 SKU / ASIN')).toBeInTheDocument()
    expect(screen.getByText('全部状态')).toBeInTheDocument()
  })

  it('4 个字段 wrapper 均带 md:w-auto（桌面横排契约，防 BLF-629 竖排回归）', async () => {
    const { container } = render(<InventoryReplenishmentPage />)
    // 等待项目下拉渲染完成（skeleton → Select）
    await waitFor(() => expect(screen.getByText('项目A')).toBeInTheDocument())

    // FilterToolbar 内容区 = .dashboard-toolbar > div（grid md:flex 容器）下的直接子元素
    const toolbarContent = container.querySelector('.dashboard-toolbar > div')
    expect(toolbarContent).not.toBeNull()

    const wrappers = Array.from(toolbarContent?.children ?? []).filter(
      (child) => child.tagName === 'DIV'
    )
    expect(wrappers.length).toBeGreaterThanOrEqual(4)
    for (const wrapper of wrappers) {
      expect(wrapper.className).toContain('w-full')
      expect(wrapper.className).toContain('min-w-0')
      expect(wrapper.className).toContain('md:w-auto')
    }
  })

  it('4 个字段宽度比例合理：项目 180 / 关键词 200 / 国家 140 / 风险 160', async () => {
    render(<InventoryReplenishmentPage />)
    await waitFor(() => expect(screen.getByText('项目A')).toBeInTheDocument())

    const projectTrigger = screen.getByText('项目A').closest('button[role="combobox"]')
    expect(projectTrigger?.className).toContain('md:w-[180px]')

    const keywordInput = screen.getByPlaceholderText('搜索 SKU / ASIN')
    expect(keywordInput.className).toContain('md:w-[200px]')

    const countryTrigger = screen.getByText('美国站 (US)').closest('button[role="combobox"]')
    expect(countryTrigger?.className).toContain('md:w-[140px]')

    const riskTrigger = screen.getByText('全部状态').closest('button[role="combobox"]')
    expect(riskTrigger?.className).toContain('md:w-[160px]')
  })
})
