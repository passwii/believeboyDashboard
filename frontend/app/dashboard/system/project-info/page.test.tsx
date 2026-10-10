import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { SESSION_DATA, NOTIFY, FETCH_MANAGED_PROJECTS_CACHED, FETCH_WORKFLOW_SUMMARY } = vi.hoisted(() => ({
  SESSION_DATA: { user: { id: 'u1', roleType: 'admin', operatorNameZh: '测试' } },
  NOTIFY: { notify: vi.fn() },
  FETCH_MANAGED_PROJECTS_CACHED: vi.fn().mockResolvedValue([
    { id: 1, name: '店铺甲', country: 'US', country_name: '美国站', brand_name: '甲', project_operator: null, assistant_operator: null, commission_basis: null, commission_rate: null, sort_order: 0, is_active: true, source_file: null, has_context: true, project_tier: null, store_address: null },
    { id: 2, name: '店铺乙', country: 'DE', country_name: null, brand_name: '乙', project_operator: null, assistant_operator: null, commission_basis: null, commission_rate: null, sort_order: 1, is_active: false, source_file: null, has_context: true, project_tier: 'T2', store_address: null },
  ]),
  FETCH_WORKFLOW_SUMMARY: vi.fn().mockResolvedValue({ projects: [] }),
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
  fetchManagedProjectsCached: FETCH_MANAGED_PROJECTS_CACHED,
  fetchProjectOperatorOptionsCached: vi.fn().mockResolvedValue([]),
  clearProjectClientCaches: vi.fn(),
}))

vi.mock('@/lib/project-workflows-api', () => ({
  fetchWorkflowSummary: FETCH_WORKFLOW_SUMMARY,
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

  it('项目启动状态与店铺启动流程关联展示', async () => {
    FETCH_WORKFLOW_SUMMARY.mockResolvedValueOnce({
      projects: [
        {
          project_id: 1,
          workflows: [{ kind: 'store_launch', status: 'completed' }],
        },
        {
          project_id: 2,
          workflows: [{ kind: 'store_launch', status: 'in_progress' }],
        },
      ],
    })

    render(<ProjectInfoPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '基础信息' }))

    const launchedRow = (await screen.findByText('店铺甲')).closest('tr')
    const launchingRow = screen.getByText('店铺乙').closest('tr')
    expect(within(launchedRow!).getByText('已启动')).toBeInTheDocument()
    expect(within(launchingRow!).getByText('正在启动')).toBeInTheDocument()
  })

  it('项目名称前的背景标记只对启用项目展示', async () => {
    render(<ProjectInfoPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '基础信息' }))

    const activeRow = (await screen.findByText('店铺甲')).closest('tr')
    const inactiveRow = screen.getByText('店铺乙').closest('tr')
    expect(activeRow).not.toBeNull()
    expect(inactiveRow).not.toBeNull()
    expect(within(activeRow!).getByTitle('已配置项目背景')).toBeInTheDocument()
    expect(within(inactiveRow!).queryByTitle('已配置项目背景')).not.toBeInTheDocument()
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

  it('编辑弹窗加载并显示当前站点的 Shop ID', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/projects/1/shops')) {
        return new Response(JSON.stringify([{ id: 101, country: 'US', shop_id: 'shop-us-current' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await userEvent.click((await screen.findAllByRole('button', { name: /编辑项目 店铺甲/ }))[0])
    expect(await screen.findByLabelText('美国站 Shop ID')).toHaveValue('shop-us-current')
    expect(fetchMock).toHaveBeenCalledWith('/api/backend/api/v1/projects/1/shops')
  })

  it('保存编辑项目时写入当前站点的 Shop ID', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/backend/api/v1/projects/1/shops') {
        return new Response(JSON.stringify([{ id: 101, country: 'US', shop_id: 'shop-us-current' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/backend/api/v1/projects/1/shops/US' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ id: 101, country: 'US', shop_id: 'shop-us-updated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (init?.method === 'PATCH') return new Response('{}', { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await userEvent.click((await screen.findAllByRole('button', { name: /编辑项目 店铺甲/ }))[0])
    const shopInput = await screen.findByLabelText('美国站 Shop ID')
    await userEvent.clear(shopInput)
    await userEvent.type(shopInput, 'shop-us-updated')
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/projects/1/shops/US',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ shop_id: 'shop-us-updated' }),
      })
    )
  })

  it('编辑 DE 项目保存时保留 DE country', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/backend/api/v1/projects/2/shops') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH') {
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await userEvent.click((await screen.findAllByRole('button', { name: /编辑项目 店铺乙/ }))[0])
    expect(screen.getByText('德国站 (DE)')).toBeInTheDocument()
    await screen.findByLabelText('德国站 Shop ID')
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH'
    )
    expect(patchCall?.[1]).toEqual(
      expect.objectContaining({
        body: expect.stringContaining('"country":"DE"'),
      })
    )
  })
  it('编辑项目时可把项目等级清空为「未分级」，提交 project_tier:null', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/backend/api/v1/projects/2/shops') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH') {
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })

    render(<ProjectInfoPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '基础信息' }))
    await userEvent.click((await screen.findAllByRole('button', { name: /编辑项目 店铺乙/ }))[0])
    await screen.findByLabelText('德国站 Shop ID')

    const tierSelect = screen.getByRole('combobox', { name: '项目等级' })
    expect(tierSelect).toHaveTextContent('T2')
    await userEvent.click(tierSelect)
    await userEvent.click(await screen.findByRole('option', { name: '未分级' }))
    expect(tierSelect).toHaveTextContent('未分级')
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH'
    )
    expect(patchCall?.[1]).toEqual(
      expect.objectContaining({ body: expect.stringContaining('"project_tier":null') })
    )
  })

  it('保存项目启用状态后强制刷新项目列表，避免读到缓存中的停用状态', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/api/backend/api/v1/projects/2/shops') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ id: 2, is_active: true }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })

    render(<ProjectInfoPage />)
    const basicTab = await screen.findByRole('tab', { name: '基础信息' })
    await userEvent.click(basicTab)
    await userEvent.click((await screen.findAllByRole('button', { name: /编辑项目 店铺乙/ }))[0])
    await screen.findByLabelText('德国站 Shop ID')
    const switchControl = screen.getByRole('switch', { name: '启用项目' })
    expect(switchControl).toHaveAttribute('data-state', 'unchecked')
    await userEvent.click(switchControl)
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))

    expect(FETCH_MANAGED_PROJECTS_CACHED).toHaveBeenLastCalledWith(
      expect.anything(),
      true,
      { force: true }
    )
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/backend/api/v1/projects/2' && init?.method === 'PATCH'
    )
    expect(patchCall?.[1]).toEqual(
      expect.objectContaining({ body: expect.stringContaining('"is_active":true') })
    )
  })
})
