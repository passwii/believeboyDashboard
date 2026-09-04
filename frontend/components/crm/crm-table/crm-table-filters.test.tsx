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

  it('翻页（非筛选 URL 变更）不会被误重置回第 1 页（回归：引用比较 bug）', async () => {
    // 起点第 2 页，filters 为空
    mockSearchParams = new URLSearchParams('page=2')
    const fetchPage = vi.fn(async (params: { page?: number }) => ({
      items: [{ id: '1', name: '客户A' }],
      total: 60, // > pageSize 20 → 分页可见（3 页）
      page: params.page ?? 1,
      pageSize: 20,
    }))
    const { rerender } = renderTable(fetchPage, fields)

    const nextBtn = await screen.findByLabelText('下一页')

    // 点下一页 → setPage(3) → URL page=3；filters 内容不变（仍为空数组）
    fireEvent.click(nextBtn)
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })

    // 修复后：filtersKey（JSON 内容）未变，page-reset effect 不触发 setPage(1)。
    // 最近一次 replace 应保留 page=3；修复前引用比较会误删 page 弹回第 1 页。
    const lastUrl = mockReplace.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain('page=3')

    await waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.page).toBe(3)
    })
  })
})


describe('CrmTable · 筛选 select 受控 value（P5-4）', () => {
  it('深链带 filters 时 select 显示对应 value（不是默认「全部」）', async () => {
    mockSearchParams = new URLSearchParams(
      'filters=' + encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'active' }]))
    )
    const fetchPage = makeFetchPage()
    renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态') as HTMLSelectElement
    // 受控 value 应等于 URL 中的 filter value
    expect(select.value).toBe('active')
  })

  it('URL filters 变化时 rerender 让 select value 跟着变', async () => {
    mockSearchParams = new URLSearchParams(
      'filters=' + encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'active' }]))
    )
    const fetchPage = makeFetchPage()
    const { rerender } = renderTable(fetchPage, fields)
    let select = await screen.findByLabelText('状态') as HTMLSelectElement
    expect(select.value).toBe('active')

    // 改 URL 模拟「用户从另一页深链带 lost」
    mockSearchParams = new URLSearchParams(
      'filters=' + encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'lost' }]))
    )
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })
    select = screen.getByLabelText('状态') as HTMLSelectElement
    expect(select.value).toBe('lost')
  })
})


describe('CrmTable · 筛选变更原子重置 page（P5-12）', () => {
  it('从 page=3 改筛选只触发 1 次 fetchPage（原子 URL 写）', async () => {
    mockSearchParams = new URLSearchParams('page=3')
    const fetchPage = makeFetchPage()
    const { rerender } = renderTable(fetchPage, fields)
    const select = await screen.findByLabelText('状态') as HTMLSelectElement

    // 触发筛选变更
    fireEvent.change(select, { target: { value: 'active' } })

    // rerender 让 hook 读取最新 URL
    await act(async () => {
      rerender(
        <CrmTable queryKey="t" fetchPage={fetchPage} columns={columns} rowKey="id" filterFields={fields} />
      )
    })

    // P5-12: 原子写后只触发 1 次 fetch（不是 2 次：filter write + page reset write）
    // 抓所有 fetchPage 调用，最后一次的 args 应同时含 filters 和 page=1
    const lastCall = fetchPage.mock.calls.at(-1)?.[0]
    expect(lastCall?.filters).toEqual([{ field: 'status', op: 'eq', value: 'active' }])
    expect(lastCall?.page).toBe(1)
    // 替换次数（mockReplace）应 <= 1（原子 router.replace），
    // 允许 1（首次）+ 0（effect setPage 不再触发）
    const totalReplaces = mockReplace.mock.calls.length
    expect(totalReplaces).toBeLessThanOrEqual(1)
  })
})
