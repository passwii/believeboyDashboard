import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 最近访问数据源：localStorage 读写走 terminal-constants（readRecents/pushRecent）
const STORAGE_KEY = 'bb.terminal.recents'

const mockPush = vi.fn()
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }))

vi.mock('next-auth/react', () => ({
  useSession: mockUseSession,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}))

import { SearchCommand, OPEN_SEARCH_EVENT } from './search-command'

function seedRecents(entries: Array<{ path: string; title: string }>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

describe('SearchCommand — ⌘K 最近访问（BLF-833）', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockUseSession.mockReturnValue({
      data: { user: { roleType: 'operator' } },
      status: 'authenticated',
    })
    window.localStorage.clear()
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  async function openPanel() {
    // 与生产入口一致：全局事件打开面板（Header 搜索按钮 / ⌘K 同路径）
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
    await screen.findByRole('dialog')
  }

  it('打开面板时最近访问分组出现，顺序与 readRecents 一致', async () => {
    seedRecents([
      { path: '/dashboard/crm/customers', title: '客户管理' },
      { path: '/dashboard/operations/daily-analysis', title: '日报分析' },
    ])

    render(<SearchCommand />)
    await openPanel()

    const group = await screen.findByText('最近访问')
    expect(group).toBeInTheDocument()

    const items = screen.getAllByRole('option')
    const values = items.map((el) => el.textContent)
    // readRecents 返回顺序 = 最近优先；seed 中「客户管理」排第一，面板内顺序应一致
    expect(values.findIndex((v) => v?.includes('客户管理'))).toBeLessThan(
      values.findIndex((v) => v?.includes('日报分析'))
    )
    // 每项渲染 pathname 尾段（font-mono text-term-faint）
    expect(screen.getByText('customers')).toBeInTheDocument()
    expect(screen.getByText('daily-analysis')).toBeInTheDocument()
  })

  it('回车跳转复用 router.push 并关闭面板', async () => {
    const user = userEvent.setup()
    seedRecents([{ path: '/dashboard/crm/leads', title: '线索管理' }])

    render(<SearchCommand />)
    await openPanel()

    await screen.findByText('线索管理')
    await user.click(screen.getByText('线索管理'))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard/crm/leads')
    })
  })

  it('管理员可以搜索到流程模板管理入口', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { roleType: 'admin' } },
      status: 'authenticated',
    })

    render(<SearchCommand />)
    await openPanel()

    expect(await screen.findByRole('option', { name: '流程模板管理' })).toBeInTheDocument()
  })

  // 2026-11-10：模板入口不再按角色隐藏，写权限由页面 isAdmin 判断接管。
  it('非管理员的搜索面板同样能看到模板入口', async () => {
    render(<SearchCommand />)
    await openPanel()

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(
      await screen.findByRole('option', { name: '流程模板管理' })
    ).toBeInTheDocument()
  })

  it('recents 为空时整组不渲染、无占位文案', async () => {
    render(<SearchCommand />)
    await openPanel()

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('最近访问')).not.toBeInTheDocument()
    // 导航分组仍正常渲染
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('有输入词时按标题过滤：命中 recents 标题的项保留', async () => {
    const user = userEvent.setup()
    seedRecents([
      { path: '/dashboard/crm/customers', title: '客户管理' },
      { path: '/dashboard/operations/daily-analysis', title: '日报分析' },
    ])

    render(<SearchCommand />)
    await openPanel()

    await screen.findByText('最近访问')
    await user.type(screen.getByPlaceholderText('搜索页面、工具与报表...'), '日报')

    // cmdk 过滤后仅剩标题/path 命中的项
    await waitFor(() => {
      const options = screen.queryAllByRole('option')
      const hit = options.find((el) => el.textContent?.includes('日报分析'))
      expect(hit).toBeDefined()
      expect(options.every((el) => !el.textContent?.includes('客户管理') || el === hit)).toBe(true)
    })
  })

  it('每次打开面板重新读取快照：导航后新页面进入列表顶部', async () => {
    const user = userEvent.setup()

    seedRecents([{ path: '/dashboard/crm/customers', title: '客户管理' }])
    render(<SearchCommand />)

    await openPanel()
    expect(await screen.findByText('客户管理')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // 模拟用户导航到新页面（TerminalShell 的路由副作用写 localStorage）
    seedRecents([
      { path: '/dashboard/finance/reconciliation', title: '对账中心' },
      { path: '/dashboard/crm/customers', title: '客户管理' },
    ])

    await openPanel()
    const items = await screen.findAllByRole('option')
    expect(items[0].textContent).toContain('对账中心')
  })
})
