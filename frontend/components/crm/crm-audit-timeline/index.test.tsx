import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CrmAuditTimeline } from './index'
import type { AuditLog, Paginated } from '@/lib/crm/types'

// 用 vi.hoisted 提升 mock，规避 vi.mock 工厂的变量提升限制。
// client 必须是稳定对象（生产 provider 用 useMemo 返回稳定 client），
// 否则每次 render 新对象 → load useCallback 依赖抖动 → useEffect 循环。
const { mockClient, mockListContacts, mockListAuditLogs } = vi.hoisted(() => {
  const mockListContacts = vi.fn()
  const mockListAuditLogs = vi.fn()
  return {
    mockClient: { listContacts: mockListContacts, listAuditLogs: mockListAuditLogs },
    mockListContacts,
    mockListAuditLogs,
  }
})

vi.mock('@/lib/crm/api/crm-client-provider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/crm/api/crm-client-provider')>()
  return {
    ...actual,
    useCrmClient: () => mockClient,
  }
})

const now = new Date().toISOString()

function auditPage(items: AuditLog[]): Paginated<AuditLog> {
  return { items, total: items.length, page: 1, pageSize: 50 }
}

describe('CrmAuditTimeline (P5-9 客户抽屉联系人审计)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('客户场景：取联系人 id 并合并查询 customer + contact 审计', async () => {
    mockListContacts.mockResolvedValue([
      { id: '101', customerId: '5', name: '张三', isPrimary: true, createdAt: now, updatedAt: now },
      { id: '102', customerId: '5', name: '李四', isPrimary: false, createdAt: now, updatedAt: now },
    ])
    mockListAuditLogs.mockResolvedValue(
      auditPage([
        { id: 'a1', entityType: 'customer', entityId: '5', action: 'create', actorId: 'u1', actorName: '小王', summary: '新建客户', createdAt: now },
        { id: 'a2', entityType: 'contact', entityId: '101', action: 'update', actorId: 'u1', actorName: '小王', summary: '电话: 旧→新', createdAt: now },
      ])
    )

    render(<CrmAuditTimeline entityType="customer" entityId="5" />)

    // 客户审计 + 联系人审计都可见
    expect(await screen.findByText('新建客户')).toBeTruthy()
    expect(screen.getByText('电话: 旧→新')).toBeTruthy()

    // listContacts 按客户 id 取联系人
    expect(mockListContacts).toHaveBeenCalledWith('5')

    // listAuditLogs 合并查询：entityTypes 含 customer+contact，entityIds 含客户 id + 联系人 id
    const query = mockListAuditLogs.mock.calls[0][0]
    expect(query.entityTypes).toEqual(expect.arrayContaining(['customer', 'contact']))
    expect(query.entityIds).toEqual(expect.arrayContaining([5, 101, 102]))
  })

  it('客户无联系人时退回单实体查询（不传 entityTypes/entityIds）', async () => {
    mockListContacts.mockResolvedValue([])
    mockListAuditLogs.mockResolvedValue(
      auditPage([
        { id: 'a1', entityType: 'customer', entityId: '7', action: 'create', actorId: 'u1', actorName: '小王', summary: '新建客户', createdAt: now },
      ])
    )

    render(<CrmAuditTimeline entityType="customer" entityId="7" />)
    expect(await screen.findByText('新建客户')).toBeTruthy()

    const query = mockListAuditLogs.mock.calls[0][0]
    expect(query.entityTypes).toBeUndefined()
    expect(query.entityIds).toBeUndefined()
    expect(query.entityType).toBe('customer')
    expect(query.entityId).toBe('7')
  })

  it('线索场景：不取联系人，走单实体查询', async () => {
    mockListAuditLogs.mockResolvedValue(
      auditPage([
        { id: 'a1', entityType: 'lead', entityId: '9', action: 'create', actorId: 'u1', actorName: '小王', summary: '新建线索', createdAt: now },
      ])
    )

    render(<CrmAuditTimeline entityType="lead" entityId="9" />)
    expect(await screen.findByText('新建线索')).toBeTruthy()

    expect(mockListContacts).not.toHaveBeenCalled()
    const query = mockListAuditLogs.mock.calls[0][0]
    expect(query.entityTypes).toBeUndefined()
    expect(query.entityType).toBe('lead')
  })
})
