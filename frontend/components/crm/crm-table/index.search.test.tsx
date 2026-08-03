import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// 与 crm-table-filters.test.tsx 同款 next/navigation mock：真 hook 范式，
// router.replace 把新 query 写回 mockSearchParams，rerender 后 hook 重新读取。
const mockReplace = vi.fn((url: string) => {
  const qs = url.split('?')[1] ?? ''
  mockSearchParams = new URLSearchParams(qs)
})
let mockSearchParams = new URLSearchParams()
const mockPathname = '/dashboard/crm/customers'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}))

// eslint-disable-next-line import/first
import { CrmTable } from './index'

const columns = [{ key: 'name', title: '客户名' }]

beforeEach(() => {
  mockReplace.mockClear()
  mockSearchParams = new URLSearchParams()
})

afterEach(() => vi.useRealTimers())

describe('CrmTable · 搜索集成（真 hook）', () => {
  it('searchable 输入防抖后以 keyword 调用 fetchPage', async () => {
    vi.useFakeTimers()
    const fetchPage = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))
    const { rerender } = render(
      <CrmTable
        queryKey="t"
        fetchPage={fetchPage}
        columns={columns}
        rowKey="id"
        searchable
        searchPlaceholder="搜名"
      />
    )
    // flush 初始 fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.change(screen.getByPlaceholderText('搜名'), { target: { value: '甲' } })
    // 防抖 300ms → CrmSearchInput 调 setKeyword → router.replace 写 keyword=甲
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    // rerender 让 hook 重读 mockSearchParams（keyword=甲）→ runFetch
    await act(async () => {
      rerender(
        <CrmTable
          queryKey="t"
          fetchPage={fetchPage}
          columns={columns}
          rowKey="id"
          searchable
          searchPlaceholder="搜名"
        />
      )
    })
    // flush 异步 fetchPage
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const last = fetchPage.mock.calls.at(-1)?.[0]
    expect(last?.keyword).toBe('甲')
  })

  it('每页条数 select 变更后以新 pageSize 调用 fetchPage', async () => {
    const fetchPage = vi.fn(async () => ({
      items: [{ id: '1', name: 'A' }],
      total: 60,
      page: 1,
      pageSize: 20,
    }))
    const { rerender } = render(
      <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" />
    )
    await waitFor(() => expect(fetchPage).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } })
    await act(async () => {
      rerender(<CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" />)
    })
    await waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.pageSize).toBe(50)
    })
  })
})
