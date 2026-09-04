import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdAnalysisTopFilters } from '@/components/dashboard/ad-analysis/top-filters'
import {
  HeaderSlotMount,
  TerminalHeaderSlotProvider,
} from '@/components/terminal/terminal-header-slot'

// ── mocks（稳定引用：effect 依赖 session/searchParams，引用抖动会引发重复拉取）──

const { stableSession } = vi.hoisted(() => ({
  stableSession: { user: { id: 'user-1', roleType: 'admin', operatorNameZh: '张三' } },
}))

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
// 稳定引用：组件 effect 依赖 router/session，引用抖动会引发无限重复拉取
const { routerReplace, stableRouter } = vi.hoisted(() => {
  const routerReplace = vi.fn()
  return { routerReplace, stableRouter: { replace: routerReplace, push: vi.fn(), refresh: vi.fn() } }
})
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-analysis/overview',
  useRouter: () => stableRouter,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: stableSession, status: 'authenticated' as const }),
}))

const { projectsPayload, fetchProjectsMock } = vi.hoisted(() => ({
  projectsPayload: [
    { id: 1, name: '店铺A' },
    { id: 2, name: '店铺B' },
  ],
  fetchProjectsMock: vi.fn(),
}))
vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: fetchProjectsMock,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

// Radix Select 在 jsdom 下需要 PointerEvent 与 scrollIntoView 才能交互
beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      public pointerId: number
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params)
        this.pointerId = params.pointerId ?? 0
      }
    }
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill
  }
})

/** 模拟 TerminalHeader：真实挂 HeaderSlotMount，让 portal 控件渲染进 DOM */
function FakeHeader() {
  return (
    <header data-testid="fake-header">
      <HeaderSlotMount className="flex items-center gap-1.5" />
    </header>
  )
}

function renderWithHeader() {
  return render(
    <TerminalHeaderSlotProvider>
      <FakeHeader />
      <AdAnalysisTopFilters />
    </TerminalHeaderSlotProvider>
  )
}

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSearchParams = new URLSearchParams('projectId=1&country=US')
  fetchProjectsMock.mockReset()
  fetchProjectsMock.mockImplementation(() => Promise.resolve(projectsPayload))
  routerReplace.mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AdAnalysisTopFilters 头部插槽化（BLF-889）', () => {
  it('筛选控件 portal 进 Top Header 插槽，页面内不再渲染筛选区块', async () => {
    renderWithHeader()

    const slot = screen.getByTestId('terminal-header-slot')
    // 项目 / 站点 / 日期三控件出现在插槽内
    await waitFor(() => expect(within(slot).getByTitle('项目筛选')).toBeInTheDocument())
    expect(within(slot).getByTitle('站点筛选')).toBeInTheDocument()
    expect(slot.textContent).toContain('店铺A')

    // 旧页面级筛选区已删除：不再出现 TermPanel 标题、说明文案与只读胶囊
    expect(screen.queryByText('广告分析筛选区')).toBeNull()
    expect(screen.queryByText(/筛选条件固定放在顶部/)).toBeNull()
    expect(screen.queryByText(/当前视图/)).toBeNull()
  })

  it('无下钻参数时不渲染下钻 token 与清空按钮', async () => {
    renderWithHeader()

    const slot = screen.getByTestId('terminal-header-slot')
    await waitFor(() => expect(within(slot).getByTitle('项目筛选')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '清空下钻' })).toBeNull()
  })

  it('有下钻参数时渲染 token + 清空按钮；点击清空只移除下钻参数、保留基础筛选', async () => {
    mockSearchParams = new URLSearchParams('projectId=1&country=US&campaign=CAM-A&sku=SKU-001')
    const user = userEvent.setup()
    renderWithHeader()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '清空下钻' })).toBeInTheDocument()
    )
    expect(screen.getByText('活动：CAM-A')).toBeInTheDocument()
    expect(screen.getByText('SKU：SKU-001')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清空下钻' }))

    expect(routerReplace).toHaveBeenCalledTimes(1)
    const href = routerReplace.mock.calls[0][0] as string
    expect(href).not.toContain('campaign=')
    expect(href).not.toContain('sku=')
    expect(href).toContain('projectId=1')
    expect(href).toContain('country=US')
  })

  it('切换项目控件把 projectId 写进新 URL（其余筛选保留）', async () => {
    const user = userEvent.setup()
    renderWithHeader()

    const slot = screen.getByTestId('terminal-header-slot')
    const projectSelect = await within(slot).findByTitle('项目筛选')
    await user.click(projectSelect)
    await user.click(screen.getByRole('option', { name: '店铺B' }))

    expect(routerReplace).toHaveBeenCalledTimes(1)
    const href = routerReplace.mock.calls[0][0] as string
    expect(href).toContain('projectId=2')
    expect(href).toContain('country=US')
  })

  it('无 projectId 时自动选中第一个项目（沿用 autoSelectFirst 行为）', async () => {
    mockSearchParams = new URLSearchParams('country=DE')
    renderWithHeader()

    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1))
    const href = routerReplace.mock.calls[0][0] as string
    expect(href).toContain('projectId=1')
    expect(href).toContain('country=DE')
  })

  it('项目列表加载失败时在插槽内渲染错误信息', async () => {
    fetchProjectsMock.mockImplementationOnce(() => Promise.reject(new Error('后端不可用')))

    renderWithHeader()

    const slot = screen.getByTestId('terminal-header-slot')
    await waitFor(() => expect(slot.textContent).toContain('后端不可用'))
  })
})
