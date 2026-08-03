import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CrmSeaTable } from './sea-table'

const { listCustomers, mockClient } = vi.hoisted(() => {
  const listCustomers = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  const mockClient = {
    listCustomers,
    listFollows: vi.fn().mockResolvedValue([]),
    createFollow: vi.fn(),
    claimFromSea: vi.fn(),
  }
  return { listCustomers, mockClient }
})
// 返回稳定 client 对象（避免每次渲染新对象导致 fetchPage 不稳定 → 无限重 fetch）
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => mockClient,
}))
vi.mock('@/hooks/use-crm-users', () => ({ useCrmUsers: () => [] }))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify: vi.fn() }) }))
// 真 useCrmTable 需要完整 next/navigation；useSearchParams 必须返回稳定对象
// （否则 hook 的 useMemo([searchParams]) 每次重算 → runFetch 重建 → 无限重 fetch）
const mockSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/crm/sea',
  useSearchParams: () => mockSearchParams,
}))

describe('CrmSeaTable', () => {
  it('渲染搜索框/导出按钮/进公海时长列/筛选行，且按 scope=sea 拉数', async () => {
    render(<CrmSeaTable />)
    // 导出按钮（外层工具栏，立即渲染）
    expect(screen.getByTestId('crm-export-csv')).toBeTruthy()
    // 工具栏提示
    expect(screen.getByText(/公海客户/)).toBeTruthy()
    // 搜索框在 CrmTable 内，需等初始 fetch 完成（loading 结束）才渲染
    expect(await screen.findByPlaceholderText(/搜索客户名/)).toBeTruthy()
    // 进公海时长列（仅列头，唯一）
    expect(screen.getByText('进公海时长')).toBeTruthy()
    // 快捷筛选行（对象类型仅为筛选项、非列头，唯一匹配）
    expect(screen.getByText('对象类型')).toBeTruthy()
    // 按 scope=sea 拉数
    await waitFor(() =>
      expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sea' }))
    )
  })
})
