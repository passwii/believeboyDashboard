import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Paginated } from '@/lib/crm/api/crm-client'

const mockPush = vi.fn()
const mockReplace = vi.fn((url: string) => {
 const qs = url.split('?')[1] ?? ''
 mockSearchParams = new URLSearchParams(qs)
})
let mockSearchParams = new URLSearchParams()
let mockPathname = '/dashboard/crm/customers'

vi.mock('next/navigation', () => ({
 useRouter: () => ({ push: mockPush, replace: mockReplace }),
 usePathname: () => mockPathname,
 useSearchParams: () => mockSearchParams,
}))

// eslint-disable-next-line import/first
import { useCrmTable } from './use-crm-table'

beforeEach(() => {
 mockPush.mockReset()
 mockReplace.mockClear()
 mockSearchParams = new URLSearchParams()
 mockPathname = '/dashboard/crm/customers'
})

const makePage = <T,>(items: T[], total = items.length, page = 1, pageSize = 20): Paginated<T> => ({
 items,
 total,
 page,
 pageSize,
})

describe('useCrmTable · state init', () => {
 it('默认 page=1 / pageSize=20 / keyword="" / filters=[]', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'customers', fetchPage: vi.fn() }),
 )
 expect(result.current.page).toBe(1)
 expect(result.current.pageSize).toBe(20)
 expect(result.current.keyword).toBe('')
 expect(result.current.filters).toEqual([])
 expect(result.current.sortBy).toBeUndefined()
 expect(result.current.sortOrder).toBeUndefined()
 })

 it('支持自定义 defaultPageSize', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn(), defaultPageSize: 50 }),
 )
 expect(result.current.pageSize).toBe(50)
 })

 it('从 URL 读取 page', () => {
 mockSearchParams = new URLSearchParams('page=3')
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 expect(result.current.page).toBe(3)
 })

 it('从 URL 读取 sortBy + sortOrder', () => {
 mockSearchParams = new URLSearchParams('sortBy=updatedAt&sortOrder=desc')
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 expect(result.current.sortBy).toBe('updatedAt')
 expect(result.current.sortOrder).toBe('desc')
 })

 it('从 URL 读取 keyword', () => {
 mockSearchParams = new URLSearchParams('keyword=foo')
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 expect(result.current.keyword).toBe('foo')
 })

 it('从 URL 读取 filters（URL 编码 JSON）', () => {
 const filters = [{ field: 'status', op: 'eq', value: 'active' }]
 mockSearchParams = new URLSearchParams(
 `filters=${encodeURIComponent(JSON.stringify(filters))}`,
 )
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 expect(result.current.filters).toEqual(filters)
 })
})

describe('useCrmTable · URL sync', () => {
 it('setPage 写入 ?page=N', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setPage(2))
 expect(mockReplace).toHaveBeenCalledWith(
 '/dashboard/crm/customers?page=2',
 { scroll: false },
 )
 })

 it('setKeyword 写入 ?keyword=xxx', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setKeyword('hello'))
 expect(mockReplace).toHaveBeenCalledWith(
 '/dashboard/crm/customers?keyword=hello',
 { scroll: false },
 )
 })

 it('setKeyword("") 删除 ?keyword', () => {
 mockSearchParams = new URLSearchParams('keyword=hello')
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setKeyword(''))
 expect(mockReplace.mock.calls.at(-1)?.[0]).toBe('/dashboard/crm/customers')
 })

 it('toggleSort 三态循环：undefined → asc → desc → undefined', () => {
 const { result, rerender } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.toggleSort('updatedAt'))
 rerender()
 expect(result.current.sortBy).toBe('updatedAt')
 expect(result.current.sortOrder).toBe('asc')
 act(() => result.current.toggleSort('updatedAt'))
 rerender()
 expect(result.current.sortOrder).toBe('desc')
 act(() => result.current.toggleSort('updatedAt'))
 rerender()
 expect(result.current.sortBy).toBeUndefined()
 expect(result.current.sortOrder).toBeUndefined()
 })

 it('toggleSort 切换到不同列时重置为 asc', () => {
 const { result, rerender } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.toggleSort('name'))
 rerender()
 act(() => result.current.toggleSort('name'))
 rerender()
 act(() => result.current.toggleSort('updatedAt'))
 rerender()
 expect(result.current.sortBy).toBe('updatedAt')
 expect(result.current.sortOrder).toBe('asc')
 })

 it('setFilters 写入 URL 编码的 JSON', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 const filters = [{ field: 'status', op: 'eq', value: 'active' }]
 act(() => result.current.setFilters(filters))
 const url = mockReplace.mock.calls.at(-1)?.[0] as string
 const encoded = url.split('filters=')[1].split('&')[0]
 expect(JSON.parse(decodeURIComponent(encoded))).toEqual(filters)
 })

 it('setFilters([]) 删除 ?filters', () => {
 const initialFilters = [{ field: 'status', op: 'eq', value: 'active' }]
 mockSearchParams = new URLSearchParams(
 `filters=${encodeURIComponent(JSON.stringify(initialFilters))}`,
 )
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setFilters([]))
 expect(mockReplace.mock.calls.at(-1)?.[0]).toBe('/dashboard/crm/customers')
 })

 it('setFilters 包含 AND/OR 嵌套也能序列化', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 const filters = [
 {
 and: [
 { field: 'status', op: 'eq', value: 'active' },
 { field: 'rating', op: 'eq', value: 'A' },
 ],
 },
 ]
 act(() => result.current.setFilters(filters))
 const url = mockReplace.mock.calls.at(-1)?.[0] as string
 const encoded = url.split('filters=')[1].split('&')[0]
 expect(JSON.parse(decodeURIComponent(encoded))).toEqual(filters)
 })

 it('reset 全部清空', () => {
 mockSearchParams = new URLSearchParams(
 'page=5&keyword=foo&sortBy=updatedAt&sortOrder=desc',
 )
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.reset())
 expect(mockReplace).toHaveBeenCalledWith('/dashboard/crm/customers', { scroll: false })
 })

 it('setPage(1) 删除 ?page', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setPage(1))
 expect(mockReplace.mock.calls.at(-1)?.[0]).toBe('/dashboard/crm/customers')
 })

 it('所有写操作走 router.replace，不走 push', () => {
 const { result } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }),
 )
 act(() => result.current.setKeyword('test'))
 act(() => result.current.setPage(2))
 act(() => result.current.setFilters([{ field: 'status', op: 'eq', value: 'active' }]))
 expect(mockPush).not.toHaveBeenCalled()
 expect(mockReplace).toHaveBeenCalledTimes(3)
 })
})

describe('useCrmTable · fetch', () => {
 it('挂载时立即 fetch 一次（默认参数）', async () => {
 const fetchPage = vi.fn().mockResolvedValue(makePage([]))
 renderHook(() => useCrmTable({ queryKey: 'customers', fetchPage }))
 await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
 const callArgs = fetchPage.mock.calls[0][0]
 expect(callArgs.page).toBe(1)
 expect(callArgs.pageSize).toBe(20)
 })

 it('fetchPage 返回 data 后 result.data 更新', async () => {
 const fetchPage = vi.fn().mockResolvedValue(makePage([{ id: '1' }], 1))
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage }))
 await waitFor(() => expect(result.current.data).toEqual([{ id: '1' }]))
 expect(result.current.total).toBe(1)
 expect(result.current.loading).toBe(false)
 expect(result.current.error).toBeNull()
 })

 it('fetchPage 抛错时 result.error 被设置', async () => {
 const fetchPage = vi.fn().mockRejectedValue(new Error('boom'))
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage }))
 await waitFor(() => expect(result.current.error?.message).toBe('boom'))
 })

 it('参数变化触发重新 fetch', async () => {
 const fetchPage = vi.fn().mockResolvedValue(makePage([]))
 const { result, rerender } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage }))
 await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
 act(() => result.current.setPage(2))
 rerender()
 await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2))
 expect(fetchPage.mock.calls.at(-1)?.[0].page).toBe(2)
 })

 it('refresh 强制重 fetch', async () => {
 const fetchPage = vi.fn().mockResolvedValue(makePage([]))
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage }))
 await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
 await act(async () => {
 await result.current.refresh()
 })
 expect(fetchPage).toHaveBeenCalledTimes(2)
 })
})

describe('useCrmTable · loading state', () => {
 it('fetch 期间 loading=true，完成后 loading=false', async () => {
 let resolveFetch!: (v: Paginated<unknown>) => void
 const fetchPage = vi.fn().mockImplementation(
 () =>
 new Promise<Paginated<unknown>>((resolve) => {
 resolveFetch = resolve
 }),
 )
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage }))
 await waitFor(() => expect(result.current.loading).toBe(true))
 act(() => {
 resolveFetch(makePage([]))
 })
 await waitFor(() => expect(result.current.loading).toBe(false))
 })
})

describe('useCrmTable · scope 透传', () => {
 it('把 scope 透传给 fetchPage.params', async () => {
 const fetchPage = vi.fn().mockResolvedValue(makePage([]))
 const { result, rerender } = renderHook(() =>
 useCrmTable({ queryKey: 'x', fetchPage, scope: 'mine' }),
 )
 await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
 expect(fetchPage.mock.calls[0][0].scope).toBe('mine')
 act(() => result.current.setScope('all'))
 rerender()
 await waitFor(() => expect(fetchPage.mock.calls.at(-1)?.[0].scope).toBe('all'))
 })
})

describe('useCrmTable · 数据校验', () => {
 it('无效的 page（负数）回退到 1', () => {
 mockSearchParams = new URLSearchParams('page=-3')
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }))
 expect(result.current.page).toBe(1)
 })

 it('无效的 sortOrder 回退到 undefined', () => {
 mockSearchParams = new URLSearchParams('sortOrder=random')
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }))
 expect(result.current.sortOrder).toBeUndefined()
 })

 it('无效的 filters JSON 视为空数组', () => {
 mockSearchParams = new URLSearchParams('filters=not-json')
 const { result } = renderHook(() => useCrmTable({ queryKey: 'x', fetchPage: vi.fn() }))
 expect(result.current.filters).toEqual([])
 })
})