import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { FilterFieldDef } from './types'

// 与 use-crm-table.test.tsx 同款 next/navigation mock：
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

const fields: FilterFieldDef[] = [
  {
    key: 'status',
    label: '状态',
    type: 'select',
    field: 'status',
    options: [
      { label: '活跃', value: 'active' },
      { label: '流失', value: 'lost' },
    ],
  },
]

const columns = [{ key: 'name', title: '客户名' }]

const makeFetchPage = () =>
  vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))

beforeEach(() => {
  mockReplace.mockClear()
  mockSearchParams = new URLSearchParams()
})

function renderTable(fetchPage: ReturnType<typeof makeFetchPage>, filterFields?: FilterFieldDef[]) {
  return render(
    <CrmTable
      queryKey="t"
      fetchPage={fetchPage}
      columns={columns}
      rowKey="id"
      filterFields={filterFields}
    />
  )
}

describe('CrmTable · 快捷筛选行', () => {
  it('传 filterFields 时渲染筛选下拉（含选项）', async () => {
    const fetchPage = makeFetchPage()
    renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态')
    expect(select).toBeInTheDocument()
    // 「全部」+ 2 个选项
    expect(screen.getByRole('option', { name: '全部' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '活跃' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '流失' })).toBeInTheDocument()
  })

  it('不传 filterFields 时不渲染筛选行', async () => {
    const fetchPage = makeFetchPage()
    renderTable(fetchPage)
    await waitFor(() => expect(fetchPage).toHaveBeenCalled())
    expect(screen.queryByLabelText('状态')).not.toBeInTheDocument()
  })

  it('选择筛选项后以 filters 调用 fetchPage，并重置到第 1 页', async () => {
    const fetchPage = makeFetchPage()
    const { rerender } = renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态')

    fireEvent.change(select, { target: { value: 'active' } })
    // URL 状态经 next/navigation mock 更新，rerender 让 hook 重新读取并重 fetch
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })

    await waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.filters).toEqual([{ field: 'status', op: 'eq', value: 'active' }])
    })
    // 筛选变更重置到第 1 页
    expect(fetchPage.mock.calls.at(-1)?.[0].page).toBe(1)
  })

  it('从第 3 页改筛选时重置到第 1 页（page-reset effect）', async () => {
    mockSearchParams = new URLSearchParams('page=3')
    const fetchPage = makeFetchPage()
    const { rerender } = renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态')

    fireEvent.change(select, { target: { value: 'lost' } })
    // rerender#1：hook 以 page=3+filters 重 fetch；page-reset effect 检测到 filters
    // 变化且 page>1，调 setPage(1) 把 page 从 URL 移除。
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })
    // effect 已执行 setPage(1)：最后一次 replace 含 filters 且不含 page
    const lastUrl = mockReplace.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain('filters=')
    expect(lastUrl).not.toContain('page=')

    // rerender#2：hook 读到 page=1，以 page=1+filters 重 fetch
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })
    await waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.filters).toEqual([{ field: 'status', op: 'eq', value: 'lost' }])
      expect(last?.page).toBe(1)
    })
  })

  it('切回「全部」时清空该字段筛选（filters 回到空）', async () => {
    mockSearchParams = new URLSearchParams(
      `filters=${encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'active' }]))}`
    )
    const fetchPage = makeFetchPage()
    const { rerender } = renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态')

    fireEvent.change(select, { target: { value: '' } })
    const lastUrl = mockReplace.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).not.toContain('filters=')

    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })
    await waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.filters).toEqual([])
    })
  })
})
