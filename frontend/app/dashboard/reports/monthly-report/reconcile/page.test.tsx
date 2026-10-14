/**
 * BLF-964 · reconcile 页 header 化契约测试。
 *
 * 验证：
 *  1. auto tab 下 slot 含项目 / 站点控件，正文无筛选 DataCard
 *  2. 切到 manual tab 后 slot 清空
 *  3. 旧 ProjectSelect / CountrySelect 不再在正文渲染
 *
 * BLF-1344 追加：项目选择跨 tab 共享，且共享记忆 / URL 里的项目必须在当前操作者
 * 可见项目列表内 —— 不可见时清记忆并回退，绝不把旧 id 交给 auto tab 发请求。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'
import {
  readSharedReportProjectId,
  writeSharedReportProjectId,
  type ReportProjectOwner,
} from '../shared-project'

// ── 操作者身份（共享记忆按它隔离） ───────────────────────────────────────────
const OWNER_A: ReportProjectOwner = { id: 'user-a', roleType: 'admin', operatorNameZh: '张三' }
const OWNER_B: ReportProjectOwner = { id: 'user-b', roleType: 'operator', operatorNameZh: '李四' }

const readMemo = (owner: ReportProjectOwner = OWNER_A) => readSharedReportProjectId(owner)
const writeMemo = (projectId: string, owner: ReportProjectOwner = OWNER_A) =>
  writeSharedReportProjectId(owner, projectId)

// ── mocks ────────────────────────────────────────────────────────────────────

// 可切换的 session：模拟「同一浏览器换账号」
const sessionState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.current,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/monthly-report/reconcile',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

// /projects/manage 的可见项目：用例可按操作者改写（换账号后可见项目可能完全不同）
const managedProjects = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; name: string; country?: string }>,
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(() => Promise.resolve(managedProjects.rows)),
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

// Mock auto/manual tabs to isolate page-level behavior；auto tab 记录每次收到的 projectId
//（它就是用这个 id 去请求 available-reports 的）
const autoTabRenders = vi.hoisted(() => ({ projectIds: [] as string[] }))

vi.mock('./auto-reconcile-tab', () => ({
  default: ({ projectId }: { projectId: string }) => {
    autoTabRenders.projectIds.push(projectId)
    return <div data-testid="auto-tab">{projectId}</div>
  },
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
  managedProjects.rows = [
    { id: 1, name: '项目A', country: 'US' },
    { id: 2, name: '项目B', country: 'DE' },
  ]
  autoTabRenders.projectIds = []
  sessionState.current = stableSession({ user: OWNER_A as Record<string, unknown> })
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

    // BLF-1344：筛选控件等共享记忆读出 + 可见项目校验完成后才挂载
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    // slot 内含 HeaderProjectSelect / HeaderCountrySelect
    expect(screen.getByTestId('header-project-select')).toBeInTheDocument()
    expect(screen.getByTestId('header-country-select')).toBeInTheDocument()
  })

  it('切到 manual tab 后 slot 清空', async () => {
    const user = userEvent.setup()
    render(<ReconcilePage />)

    // auto tab 默认激活，slot 有内容（等共享记忆读出 + 可见项目校验完成）
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())
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

    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

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
    writeMemo('2')

    render(<ReconcilePage />)

    await waitFor(() => expect(screen.getByTestId('header-project-select')).toHaveValue('2'))
    await waitFor(() => expect(screen.getByTestId('auto-tab')).toHaveTextContent('2'))
  })

  it('在项目控件里选择后写入共享记忆，供其它 tab 沿用', async () => {
    render(<ReconcilePage />)
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    fireEvent.change(screen.getByTestId('header-project-select'), { target: { value: '2' } })

    await waitFor(() => expect(readMemo()).toBe('2'))
    expect(screen.getByTestId('header-project-select')).toHaveValue('2')
  })
})

describe('BLF-1344 共享记忆的权限边界（评审阻塞项）', () => {
  it('记忆里的项目不在当前可见列表时：清记忆、回退第一个可见项目，且不把旧 id 交给 auto tab', async () => {
    // 场景：权限被收回 / 项目下架后残留的记忆
    writeMemo('999')

    render(<ReconcilePage />)

    await waitFor(() => expect(screen.getByTestId('auto-tab')).toHaveTextContent('1'))
    expect(readMemo()).toBe('1')
    // auto tab 从没拿到过不可见的 999（它拿到的 id 才会变成 available-reports 的请求参数）
    expect(autoTabRenders.projectIds).not.toContain('999')
  })

  it('换账号后不再沿用上一个账号记忆里的项目，也不改写 / 清掉它的记忆', async () => {
    // 上一个账号（张三）在这台浏览器上选过项目 2
    writeMemo('2')
    // 现在登录的是李四，可见项目只有 3
    sessionState.current = stableSession({ user: OWNER_B as Record<string, unknown> })
    managedProjects.rows = [{ id: 3, name: '项目C', country: 'US' }]

    render(<ReconcilePage />)
    await waitFor(() => expect(capturedSlotNode).not.toBeNull())

    // 新账号拿不到上一个账号的项目，也不会拿它发请求（李四没选项目 → 空值）
    expect(screen.getByTestId('auto-tab')).toHaveTextContent('')
    expect(autoTabRenders.projectIds).not.toContain('2')
    // 隔离不是清除：张三的记忆原封不动
    expect(readMemo(OWNER_A)).toBe('2')
  })

  it('可见项目列表拉不到时不放行任何项目 id（宁可不发请求）', async () => {
    writeMemo('2')
    const { fetchManagedProjectsCached } = await import('@/lib/project-client-cache')
    vi.mocked(fetchManagedProjectsCached).mockRejectedValueOnce(new Error('项目列表加载失败'))

    render(<ReconcilePage />)

    await waitFor(() => expect(vi.mocked(fetchManagedProjectsCached)).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('auto-tab')).toHaveTextContent(''))
    expect(autoTabRenders.projectIds.every((id) => id === '')).toBe(true)
  })
})
