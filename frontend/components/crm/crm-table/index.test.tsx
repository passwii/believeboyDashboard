import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import type { Paginated } from '@/lib/crm/api/crm-client'
import type { Customer } from '@/lib/crm/types'

const mockToggleSort = vi.fn()
const mockSetPage = vi.fn()
const mockSetPageSize = vi.fn()
const mockRefresh = vi.fn()
const mockSetKeyword = vi.fn()
const mockSetFiltersAndPage = vi.fn()

let mockUseCrmTableReturn = {
 data: undefined as Customer[] | undefined,
 total: 0,
 loading: false,
 error: null as Error | null,
 page: 1,
 pageSize: 20,
 sortBy: undefined as string | undefined,
 sortOrder: undefined as 'asc' | 'desc' | undefined,
 keyword: '',
 filters: [],
  setPage: mockSetPage,
  setPageSize: mockSetPageSize,
  toggleSort: mockToggleSort,
  refresh: mockRefresh,
  setKeyword: mockSetKeyword,
  setFiltersAndPage: mockSetFiltersAndPage,
}

vi.mock('@/components/crm/crm-table/use-crm-table', () => ({
 useCrmTable: () => mockUseCrmTableReturn,
}))

// eslint-disable-next-line import/first
import { CrmTable } from './index'

interface TestCustomer extends Customer {}

const sampleCustomers: TestCustomer[] = [
 {
 id: 'c-1',
 name: '客户一',
 rating: 'A',
 status: 'active',
 source: 'referral',
 ownerId: 'u-1',
 ownerName: '张三',
 createdAt: '2026-01-01T00:00:00Z',
 updatedAt: '2026-01-01T00:00:00Z',
 createdBy: 'u-1',
 contactName: '李四',
 contactPhone: '13800000001',
 },
 {
 id: 'c-2',
 name: '客户二',
 rating: 'B',
 status: 'lost',
 source: 'exhibition',
 ownerId: 'u-1',
 ownerName: '张三',
 createdAt: '2026-02-01T00:00:00Z',
 updatedAt: '2026-02-01T00:00:00Z',
 createdBy: 'u-1',
 },
]

const sampleColumns = [
 { key: 'name', title: '客户名', sortable: true },
 { key: 'rating', title: '等级' },
 { key: 'status', title: '状态' },
]

beforeEach(() => {
 mockUseCrmTableReturn = {
 data: undefined,
 total: 0,
 loading: false,
 error: null,
 page: 1,
 pageSize: 20,
 sortBy: undefined,
 sortOrder: undefined,
 keyword: '',
 filters: [],
  setPage: mockSetPage,
  setPageSize: mockSetPageSize,
  toggleSort: mockToggleSort,
  refresh: mockRefresh,
  setKeyword: mockSetKeyword,
  setFiltersAndPage: mockSetFiltersAndPage,
 }
  mockToggleSort.mockClear()
  mockSetPage.mockClear()
  mockSetPageSize.mockClear()
  mockRefresh.mockClear()
  mockSetKeyword.mockClear()
  mockSetFiltersAndPage.mockClear()
})

describe('CrmTable · 渲染', () => {
 it('数据加载时显示 skeleton', () => {
 mockUseCrmTableReturn.loading = true
 const { container } = render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(container.querySelectorAll('[data-testid="crm-table-skeleton"]').length).toBeGreaterThan(0)
 })

 it('数据为空时显示 empty state', () => {
 mockUseCrmTableReturn.data = []
 mockUseCrmTableReturn.total = 0
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" emptyText="暂无客户" />,
 )
 expect(screen.getByText('暂无客户')).toBeInTheDocument()
 })

 it('加载完成渲染列头和行', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 mockUseCrmTableReturn.total = 2
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(screen.getByText('客户名')).toBeInTheDocument()
 expect(screen.getByText('等级')).toBeInTheDocument()
 expect(screen.getByText('状态')).toBeInTheDocument()
 expect(screen.getByText('客户一')).toBeInTheDocument()
 expect(screen.getByText('客户二')).toBeInTheDocument()
 })

 it('出错时显示错误提示 + 重试按钮', () => {
 mockUseCrmTableReturn.error = new Error('加载失败')
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(screen.getByText(/加载失败/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button', { name: /重试/ }))
 expect(mockRefresh).toHaveBeenCalledTimes(1)
 })
})

describe('CrmTable · 列渲染', () => {
 it('render 函数优先于 format', () => {
 const columns = [
 {
 key: 'name',
 title: '客户名',
 render: (v: unknown) => `★${String(v)}★`,
 },
 ]
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={columns} rowKey="id" />,
 )
 expect(screen.getByText('★客户一★')).toBeInTheDocument()
 })

 it('format=enum 用 enumMap.label 渲染', () => {
 const columns = [
 {
 key: 'status',
 title: '状态',
 format: 'enum' as const,
 enumMap: {
 active: { label: '活跃', color: 'green' },
 lost: { label: '已流失', color: 'red' },
 },
 },
 ]
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={columns} rowKey="id" />,
 )
 expect(screen.getByText('活跃')).toBeInTheDocument()
 expect(screen.getByText('已流失')).toBeInTheDocument()
 })

 it('format=currency 加千分位', () => {
 const customers = [
 { ...sampleCustomers[0], annualRevenue: 1234567 },
 ] as TestCustomer[]
 const columns = [{ key: 'annualRevenue', title: '年营收', format: 'currency' as const }]
 mockUseCrmTableReturn.data = customers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={columns} rowKey="id" />,
 )
 expect(screen.getByText('1,234,567')).toBeInTheDocument()
 })

 it('format=date 用本地化日期', () => {
 const columns = [{ key: 'createdAt', title: '创建时间', format: 'date' as const }]
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={columns} rowKey="id" />,
 )
 expect(screen.getAllByText(/2026|1\/1|\u5e74/i).length).toBeGreaterThan(0)
 })
})

describe('CrmTable · 排序', () => {
 it('点击 sortable 列头调用 toggleSort(columnKey)', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 fireEvent.click(screen.getByText('客户名'))
 expect(mockToggleSort).toHaveBeenCalledWith('name')
 })

 it('非 sortable 列头不响应点击', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 fireEvent.click(screen.getByText('等级'))
 expect(mockToggleSort).not.toHaveBeenCalled()
 })

 it('当前排序列显示方向箭头（asc / desc）', () => {
 mockUseCrmTableReturn.sortBy = 'name'
 mockUseCrmTableReturn.sortOrder = 'asc'
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(screen.getByTestId('sort-asc')).toBeInTheDocument()
 })

 it('desc 时显示 ↓', () => {
 mockUseCrmTableReturn.sortBy = 'name'
 mockUseCrmTableReturn.sortOrder = 'desc'
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(screen.getByTestId('sort-desc')).toBeInTheDocument()
 })
})

describe('CrmTable · 行点击', () => {
 it('点击行调用 onRowClick(row)', () => {
 const onRowClick = vi.fn()
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 onRowClick={onRowClick}
 />,
 )
 fireEvent.click(screen.getByText('客户一'))
 expect(onRowClick).toHaveBeenCalledWith(
 expect.objectContaining({ id: 'c-1', name: '客户一' }),
 )
 })
})

describe('CrmTable · 选择', () => {
 it('selectable=false 时不显示 checkbox 列', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 const { container } = render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable={false}
 />,
 )
 expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0)
 })

 it('selectable=true 时显示 checkbox 列', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={[]}
 onSelectionChange={vi.fn()}
 />,
 )
 const checkboxes = screen.getAllByRole('checkbox')
 // 表头 1 个 + 2 行 = 3
 expect(checkboxes.length).toBe(3)
 })

 it('勾选单行触发 onSelectionChange', () => {
 const onSelectionChange = vi.fn()
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={[]}
 onSelectionChange={onSelectionChange}
 />,
 )
 const checkboxes = screen.getAllByRole('checkbox')
 // 第一个是表头"全选"，勾选第 2 行
 fireEvent.click(checkboxes[1])
 expect(onSelectionChange).toHaveBeenCalledWith(['c-1'])
 })

 it('取消勾选触发 onSelectionChange(去掉 id)', () => {
 const onSelectionChange = vi.fn()
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={['c-1', 'c-2']}
 onSelectionChange={onSelectionChange}
 />,
 )
 const checkboxes = screen.getAllByRole('checkbox')
 fireEvent.click(checkboxes[1]) // 取消勾选 c-1
 expect(onSelectionChange).toHaveBeenCalledWith(['c-2'])
 })

 it('表头 checkbox 全选 / 取消全选', () => {
 const onSelectionChange = vi.fn()
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={[]}
 onSelectionChange={onSelectionChange}
 />,
 )
 const headerCheckbox = screen.getAllByRole('checkbox')[0]
 fireEvent.click(headerCheckbox)
 expect(onSelectionChange).toHaveBeenCalledWith(['c-1', 'c-2'])
 })

 it('所有行已选时表头 checkbox 显示为勾选', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={['c-1', 'c-2']}
 onSelectionChange={vi.fn()}
 />,
 )
 const headerCheckbox = screen.getAllByRole('checkbox')[0]
 expect(headerCheckbox.getAttribute('data-state')).toBe('checked')
 })

 it('部分行已选时表头 checkbox 显示为 indeterminate', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 render(
 <CrmTable
 queryKey="x"
 fetchPage={vi.fn()}
 columns={sampleColumns}
 rowKey="id"
 selectable
 selectedIds={['c-1']}
 onSelectionChange={vi.fn()}
 />,
 )
 const headerCheckbox = screen.getAllByRole('checkbox')[0]
 expect(headerCheckbox.getAttribute('data-state')).toBe('indeterminate')
 })
})

describe('CrmTable · refreshKey', () => {
  it('refreshKey>0 时触发 refresh', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    render(
      <CrmTable
        queryKey="x"
        fetchPage={vi.fn()}
        columns={sampleColumns}
        rowKey="id"
        refreshKey={1}
      />,
    )
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('refreshKey 为 0 / 未传时不触发 refresh', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    render(
      <CrmTable
        queryKey="x"
        fetchPage={vi.fn()}
        columns={sampleColumns}
        rowKey="id"
        refreshKey={0}
      />,
    )
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})

describe('CrmTable · 分页', () => {
  it('total > pageSize 时显示分页', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    mockUseCrmTableReturn.total = 100
    mockUseCrmTableReturn.pageSize = 20
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    expect(screen.getByText(/共 100 条/)).toBeInTheDocument()
  })

 it('total <= pageSize 时显示计数但不显示跳页（仅 1 页）', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 mockUseCrmTableReturn.total = 2
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 expect(screen.getByText(/共 2 条/)).toBeInTheDocument()
 expect(screen.queryByLabelText('跳转到页码')).not.toBeInTheDocument()
 })

 it('点击下一页调用 setPage(page+1)', () => {
 mockUseCrmTableReturn.data = sampleCustomers
 mockUseCrmTableReturn.total = 100
 mockUseCrmTableReturn.page = 2
 mockUseCrmTableReturn.pageSize = 20
 render(
 <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
 )
 fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
 expect(mockSetPage).toHaveBeenCalledWith(3)
 })
})

describe('CrmTable · 搜索框（searchable）', () => {
  afterEach(() => vi.useRealTimers())

  it('searchable 渲染搜索框，输入防抖后调用 setKeyword', () => {
    vi.useFakeTimers()
    mockUseCrmTableReturn.data = []
    mockUseCrmTableReturn.keyword = ''
    render(
      <CrmTable
        queryKey="x"
        fetchPage={vi.fn()}
        columns={sampleColumns}
        rowKey="id"
        searchable
        searchPlaceholder="搜名"
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('搜名'), { target: { value: '甲' } })
    expect(mockSetKeyword).not.toHaveBeenCalledWith('甲') // 未防抖完
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(mockSetKeyword).toHaveBeenCalledWith('甲')
  })

  it('不传 searchable 时不渲染搜索框', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    expect(screen.queryByPlaceholderText(/搜索/)).not.toBeInTheDocument()
  })
})

describe('CrmTable · 分页增强', () => {
  it('每页条数 select 调用 setPageSize(number)', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    mockUseCrmTableReturn.total = 100
    mockUseCrmTableReturn.pageSize = 20
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } })
    expect(mockSetPageSize).toHaveBeenCalledWith(50)
  })

  it('首页按钮调用 setPage(1)、末页按钮调用 setPage(totalPages)', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    mockUseCrmTableReturn.total = 100
    mockUseCrmTableReturn.page = 2
    mockUseCrmTableReturn.pageSize = 20
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    fireEvent.click(screen.getByRole('button', { name: '首页' }))
    expect(mockSetPage).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: '末页' }))
    expect(mockSetPage).toHaveBeenCalledWith(5) // 100 / 20 = 5 页
  })

  it('totalPages > 1 时显示跳页输入，输入合法页码点跳调用 setPage', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    mockUseCrmTableReturn.total = 100
    mockUseCrmTableReturn.page = 1
    mockUseCrmTableReturn.pageSize = 20
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    const jumpInput = screen.getByLabelText('跳转到页码')
    fireEvent.change(jumpInput, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: '跳' }))
    expect(mockSetPage).toHaveBeenCalledWith(4)
  })

  it('跳页输入越界（>totalPages）不调用 setPage', () => {
    mockUseCrmTableReturn.data = sampleCustomers
    mockUseCrmTableReturn.total = 100
    mockUseCrmTableReturn.page = 1
    mockUseCrmTableReturn.pageSize = 20
    render(
      <CrmTable queryKey="x" fetchPage={vi.fn()} columns={sampleColumns} rowKey="id" />,
    )
    fireEvent.change(screen.getByLabelText('跳转到页码'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: '跳' }))
    expect(mockSetPage).not.toHaveBeenCalled()
  })
})
