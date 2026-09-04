import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HeaderCountrySelect,
  HeaderProjectSelect,
  TERM_HEADER_TRIGGER,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
  TERM_SELECT_CONTENT,
} from './header-filter-suite'
import {
  TerminalGlobalFilterProvider,
  useTerminalGlobalFilter,
} from './global-filter-context'

const { fetchManagedProjectsCachedMock } = vi.hoisted(() => ({
  fetchManagedProjectsCachedMock: vi.fn(),
}))
vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: fetchManagedProjectsCachedMock,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

const replaceSpy = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceSpy }),
  usePathname: () => '/dashboard/operations/daily-analysis',
}))

// 说明：HeaderDateRangePicker（Popover + 日历）在 jsdom 下渲染耗时不可控（实测挂起），
// 不在本文件渲染；其 from/to → setDateRange 行为由 global-filter-context.test.tsx 覆盖。

function Probe() {
  const ctx = useTerminalGlobalFilter()
  return (
    <span data-testid="probe" data-project={ctx.projectId} data-country={ctx.country}>
      {ctx.ready ? 'ready' : 'pending'}
    </span>
  )
}

function Suite() {
  const ctx = useTerminalGlobalFilter()
  if (!ctx.ready) return null
  return (
    <div>
      <HeaderProjectSelect value={ctx.projectId} onChange={ctx.setProjectId} />
      <HeaderCountrySelect value={ctx.country} onChange={ctx.setCountry} />
    </div>
  )
}

function renderSuite() {
  return render(
    <TerminalGlobalFilterProvider>
      <Suite />
      <Probe />
    </TerminalGlobalFilterProvider>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  fetchManagedProjectsCachedMock.mockReset()
})

describe('header-filter-suite', () => {
  it('项目选择器：value 为空时自动选中第一个项目并回写全局态（storage + URL）', async () => {
    fetchManagedProjectsCachedMock.mockResolvedValue([
      { id: 7, name: '店铺甲' },
      { id: 8, name: '店铺乙' },
    ])
    renderSuite()
    await vi.waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('bb.terminal.global-filter')!)).toMatchObject({
        projectId: '7',
      })
    )
    expect(fetchManagedProjectsCachedMock).toHaveBeenCalled()
    expect(replaceSpy).toHaveBeenCalledWith(
      expect.stringContaining('gProject=7'),
      expect.anything()
    )
    // 触发器显示自动选中的项目名
    await vi.waitFor(() => expect(screen.getByTitle('全局项目筛选')).toHaveTextContent('店铺甲'))
  })

  it('项目选择器：已有值时不自动覆盖（保持 storage 里的项目）', async () => {
    window.localStorage.setItem(
      'bb.terminal.global-filter',
      JSON.stringify({
        projectId: '8',
        country: 'US',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-07',
      })
    )
    fetchManagedProjectsCachedMock.mockResolvedValue([{ id: 7, name: '店铺甲' }])
    renderSuite()
    // 等列表加载完成后，projectId 仍是 storage 的 8，未被覆盖成 7
    await vi.waitFor(() => expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument())
    await vi.waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-project', '8'))
  })

  it('站点选择器：触发器显示当前站点；下拉打开含全部站点聚合位与站点列表', async () => {
    fetchManagedProjectsCachedMock.mockResolvedValue([{ id: 1, name: '店铺甲' }])
    renderSuite()
    const trigger = await screen.findByTitle('全局站点筛选')
    expect(trigger).toHaveTextContent(/US|美国/)
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', ctrlKey: false })
    fireEvent.click(trigger)
    await vi.waitFor(() => expect(document.body.textContent).toContain('全部站点'))
    expect(document.body.textContent).toContain('德国站 (DE)')
    expect(document.body.textContent).toContain('英国站 (UK)')
  })

  it('项目选择器：触发器仅展示项目名，不重复站点后缀（BLF-972：站点由独立 CountrySelect 承担）', async () => {
    fetchManagedProjectsCachedMock.mockResolvedValue([
      { id: 7, name: '店铺甲', country: 'US', country_name: '美国站' },
      { id: 8, name: '店铺乙', country: 'DE', country_name: null },
    ])
    renderSuite()
    const trigger = await screen.findByTitle('全局项目筛选')
    // 触发器仅展示项目名，不带站点后缀
    await vi.waitFor(() => expect(trigger).toHaveTextContent('店铺甲'))
    expect(trigger).not.toHaveTextContent('美国站')
    expect(trigger).not.toHaveTextContent('·')
  })

  it('Stage 4 三区常量：TERM_HEADER_TRIGGER / 4 档宽度 / 弹层 tokens 单源收敛（BLF-887 上档 h-10）', () => {
    expect(TERM_HEADER_TRIGGER).toContain('h-10')
    expect(TERM_HEADER_TRIGGER).toContain('border-term-border')
    expect(TERM_HEADER_W_SM).toBe('w-[130px]')
    expect(TERM_HEADER_W_MD).toBe('w-[150px]')
    expect(TERM_HEADER_W_XL).toBe('w-[240px]')
    expect(TERM_SELECT_CONTENT).toContain('border-term-border')
    expect(TERM_SELECT_CONTENT).toContain('bg-term-panel')
  })

  it('头部三区已无 FieldLabel：全局筛选四件套不再渲染 mono 标签（Stage 4 去标签化）', async () => {
    fetchManagedProjectsCachedMock.mockResolvedValue([{ id: 1, name: '店铺甲' }])
    renderSuite()
    await vi.waitFor(() => expect(screen.getByTitle('全局项目筛选')).toBeInTheDocument())
    expect(screen.queryByText('项目')).not.toBeInTheDocument()
    expect(screen.queryByText('站点')).not.toBeInTheDocument()
    expect(screen.queryByText('日期')).not.toBeInTheDocument()
  })
})
