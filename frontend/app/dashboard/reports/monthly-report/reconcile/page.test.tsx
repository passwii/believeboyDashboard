/**
 * BLF-964 · reconcile 页 header 化契约测试。
 *
 * 验证：
 *  1. auto tab 下 slot 含项目 / 站点控件，正文无筛选 DataCard
 *  2. 切到 manual tab 后 slot 清空
 *  3. 旧 ProjectSelect / CountrySelect 不再在正文渲染
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'
import { readSharedReportProjectId, writeSharedReportProjectId } from '../shared-project'

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', roleType: 'admin' } }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/monthly-report/reconcile',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: () =>
    Promise.resolve([
      { id: 1, name: '项目A', country: 'US' },
      { id: 2, name: '项目B', country: 'DE' },
    ]),
}))

// Mock HeaderProjectSelect and HeaderCountrySelect to avoid async issues
vi.mock('@/components/terminal/header-filter-suite', () => ({
  HeaderProjectSelect: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select data-testid="header-project-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">选择项目</option>
      <option value="1">项目A</option>
      <option value="2">项目B</option>
    </select>
  ),
  HeaderCountrySelect: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select data-testid="header-country-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="US">美国站</option>
      <option value="DE">德国站</option>
    </select>
  ),
}))

// Mock auto/manual tabs to isolate page-level behavior
vi.mock('./auto-reconcile-tab', () => ({
  default: () => <div data-testid="auto-tab">AutoReconcileTab</div>,
}))

vi.mock('./manual-reconcile-tab', () => ({
  default: () => <div data-testid="manual-tab">ManualReconcileTab</div>,
}))

// 捕获 slot 内容
let capturedSlotNode: React.ReactNode = null
let capturedRefreshHandler: (() => void | Promise<void>) | null = null
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    capturedRefreshHandler = handler
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: React.ReactNode) => {
    capturedSlotNode = node
    return node
  },
  useMobileFilterStrip: () => null,
}))

import ReconcilePage from './page'

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedSlotNode = null
  capturedRefreshHandler = null
})

describe('reconcile 页 header 化契约（BLF-964）', () => {
  it('auto tab 下 slot 含项目 / 站点控件', async () => {
    render(<ReconcilePage />)

    // BLF-1344：筛选控件等共享记忆读出后才挂载（避免内部兜底盖掉其它 tab 的选择）
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    // slot 内含 HeaderProjectSelect / HeaderCountrySelect
    expect(screen.getByTestId('header-project-select')).toBeInTheDocument()
    expect(screen.getByTestId('header-country-select')).toBeInTheDocument()
  })

  it('切到 manual tab 后 slot 清空', async () => {
    const user = userEvent.setup()
    render(<ReconcilePage />)

    // auto tab 默认激活，slot 有内容
    expect(capturedSlotNode).not.toBeNull()
    expect(screen.getByTestId('header-project-select')).toBeInTheDocument()

    // 切到 manual tab
    await user.click(screen.getByText('手动核对'))

    // slot 清空（useHeaderSlot(null) 返回 null）
    expect(capturedSlotNode).toBeNull()
    expect(screen.queryByTestId('header-project-select')).not.toBeInTheDocument()
  })

  it('切回 auto tab 后 slot 恢复', async () => {
    const user = userEvent.setup()
    render(<ReconcilePage />)

    // 切到 manual
    await user.click(screen.getByText('手动核对'))
    expect(capturedSlotNode).toBeNull()

    // 切回 auto
    await user.click(screen.getByText('自动核对'))
    expect(capturedSlotNode).not.toBeNull()
    expect(screen.getByTestId('header-project-select')).toBeInTheDocument()
  })

  it('旧正文筛选控件（ProjectSelect / CountrySelect）已移除', () => {
    render(<ReconcilePage />)

    // 旧筛选头使用 console/ProjectSelect 和 CountrySelect
    // 旧结构有 <label className="mb-1 block text-xs font-medium text-muted-foreground">项目</label>
    const oldLabel = screen.queryByText('项目')
    expect(oldLabel).not.toBeInTheDocument()
    expect(screen.queryByText('站点')).not.toBeInTheDocument()
  })

  it('刷新回调注册到 header', () => {
    render(<ReconcilePage />)
    expect(capturedRefreshHandler).not.toBeNull()
  })
})

describe('BLF-1344 项目选择跨 tab 共享', () => {
  it('采用共享记忆里的项目（在别的 tab 选过，切回来不用重选）', async () => {
    writeSharedReportProjectId('2')

    render(<ReconcilePage />)

    await waitFor(() => expect(screen.getByTestId('header-project-select')).toHaveValue('2'))
  })

  it('在项目控件里选择后写入共享记忆，供其它 tab 沿用', async () => {
    render(<ReconcilePage />)
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    fireEvent.change(screen.getByTestId('header-project-select'), { target: { value: '2' } })

    await waitFor(() => expect(readSharedReportProjectId()).toBe('2'))
    expect(screen.getByTestId('header-project-select')).toHaveValue('2')
  })

  it('共享记忆里的项目在页面列表里找不到时不静默选错项目', async () => {
    writeSharedReportProjectId('999')

    render(<ReconcilePage />)
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    // 页面 state 拿到的是 999（列表校验由 HeaderProjectSelect 内部 autoSelectFirst 决定）
    expect(readSharedReportProjectId()).toBe('999')
  })
})
