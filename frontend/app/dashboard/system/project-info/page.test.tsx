import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { SESSION_DATA, NOTIFY } = vi.hoisted(() => ({
  SESSION_DATA: { user: { id: 'u1', roleType: 'admin', operatorNameZh: '测试' } },
  NOTIFY: { notify: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION_DATA, status: 'authenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ startGlobalLoading: vi.fn(), endGlobalLoading: vi.fn() }),
}))

vi.mock('@/hooks/use-smooth-refresh', () => ({
  useSmoothRefresh: () => ({ showSkeleton: false, isRefreshing: false }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '店铺甲', country: 'US', country_name: '美国站', brand_name: '甲', project_operator: null, assistant_operator: null, commission_basis: null, commission_rate: null, sort_order: 0, is_active: true, source_file: null, has_context: false, project_tier: null, store_address: null },
    { id: 2, name: '店铺乙', country: 'DE', country_name: null, brand_name: '乙', project_operator: null, assistant_operator: null, commission_basis: null, commission_rate: null, sort_order: 1, is_active: true, source_file: null, has_context: false, project_tier: null, store_address: null },
  ]),
  fetchProjectOperatorOptionsCached: vi.fn().mockResolvedValue([]),
  clearProjectClientCaches: vi.fn(),
}))

// Mock heavy child components
vi.mock('@/components/dashboard/project-context/project-context-tab', () => ({
  ProjectContextTab: () => null,
}))

vi.mock('@/components/dashboard/project-context/project-context-drawer', () => ({
  ProjectContextDrawer: () => null,
}))

import ProjectInfoPage from './page'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StoreInfoPage 站点列/下拉', () => {
  it('表格表头包含「站点」列', async () => {
    render(<ProjectInfoPage />)
    // 切到基础信息 tab（默认是项目明细 tab）
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await screen.findByText('项目资料')
    expect(screen.getByText('站点')).toBeInTheDocument()
  })

  it('站点列显示中文站点名：优先后端 country_name，兜底 getCountryLabel', async () => {
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    // 店铺甲：country_name='美国站' → 直接显示
    await screen.findByText('店铺甲')
    expect(screen.getByText('美国站')).toBeInTheDocument()
    // 店铺乙：country_name=null, country='DE' → 兜底 getCountryLabel('DE')='德国站'
    await screen.findByText('店铺乙')
    expect(screen.getByText('德国站')).toBeInTheDocument()
  })

  it('新增弹窗包含「站点」下拉，默认 US', async () => {
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await screen.findByText('项目资料')
    // 点新增
    const addBtn = screen.getByRole('button', { name: '单个新增' })
    await userEvent.click(addBtn)
    // 站点下拉可见
    const countrySelect = screen.getByText('美国站 (US)')
    expect(countrySelect).toBeInTheDocument()
    // 打开下拉看选项
    const trigger = screen.getByRole('combobox', { name: '站点' })
    await userEvent.click(trigger)
    expect(screen.getByText('德国站 (DE)')).toBeInTheDocument()
    expect(screen.getByText('英国站 (UK)')).toBeInTheDocument()
  })

  it('编辑弹窗回显当前站点', async () => {
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await screen.findByText('店铺甲')
    // 点编辑按钮
    const editBtns = screen.getAllByRole('button', { name: /编辑项目 店铺甲/ })
    await userEvent.click(editBtns[0])
    // 弹窗中站点应回显 US（美国站 (US)）
    expect(screen.getByText('美国站 (US)')).toBeInTheDocument()
  })
})