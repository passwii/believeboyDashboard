import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CrmSeaTable } from './sea-table'
import type { Customer } from '@/lib/crm/types'

const { listCustomers, mockClient } = vi.hoisted(() => {
  const listCustomers = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  const mockClient = {
    listCustomers,
    listFollows: vi.fn().mockResolvedValue([]),
    createFollow: vi.fn(),
    claimFromSea: vi.fn().mockResolvedValue(undefined),
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

  it('领取成功后触发列表刷新，被领取客户立即从公海消失', async () => {
    const claimed: Customer = {
      id: 'c1',
      name: '甲公司',
      rating: 'A',
      categories: [],
      status: 'active',
      source: 'referral',
      ownerId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'u1',
    }
    // 首次拉数返回被领取客户，领取后的刷新拉数返回空（已从公海消失）
    listCustomers
      .mockReset()
      .mockResolvedValueOnce({ items: [claimed], total: 1, page: 1, pageSize: 20 })
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 })
    render(<CrmSeaTable />)
    // 初始列表出现客户
    expect(await screen.findByText('甲公司')).toBeTruthy()
    // 点击行 → 抽屉打开
    fireEvent.click(screen.getByText('甲公司'))
    // 点击「领取」
    fireEvent.click(await screen.findByRole('button', { name: '领取' }))
    // 领取接口按客户 id 调用
    await waitFor(() => expect(mockClient.claimFromSea).toHaveBeenCalledWith('c1'))
    // 领取成功后列表被主动刷新（第二次拉数）
    await waitFor(() => expect(listCustomers).toHaveBeenCalledTimes(2))
    // 被领取客户不在公海列表（行与抽屉标题均已消失）
    await waitFor(() => expect(screen.queryByText('甲公司')).toBeNull())
  })
})
