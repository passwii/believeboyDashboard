import { describe, expect, it, vi } from 'vitest'

// BEL-424 契约测试：VAT 发票页的店铺列表改走 projects/manage 2min 客户端缓存 ——
// SellerCard 与历史面板同页 mount 共享同一份缓存，不再各自裸 fetch。

const fetchManagedProjectsCached = vi.fn()
vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: (...args: unknown[]) => fetchManagedProjectsCached(...args),
}))

import { fetchProjectsManage } from './invoice-api'

describe('fetchProjectsManage（BEL-424）', () => {
  it('委托给共享客户端缓存，不直接 fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    fetchManagedProjectsCached.mockResolvedValue([{ id: 1, name: 'A', vat_enabled: true }])

    const rows = await fetchProjectsManage()

    expect(fetchManagedProjectsCached).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([{ id: 1, name: 'A', vat_enabled: true }])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('兼容 { items } 包裹形状', async () => {
    fetchManagedProjectsCached.mockResolvedValue({ items: [{ id: 2, name: 'B' }] })
    const rows = await fetchProjectsManage()
    expect(rows).toEqual([{ id: 2, name: 'B' }])
  })

  it('异常形状返回空数组而不是抛错', async () => {
    fetchManagedProjectsCached.mockResolvedValue({ unexpected: true })
    const rows = await fetchProjectsManage()
    expect(rows).toEqual([])
  })
})
