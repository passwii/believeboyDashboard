import { describe, it, expect, beforeEach } from 'vitest'
import { MockCrmClient } from '@/lib/crm/api/mock-crm-client'
import {
  CUSTOMERS_FIXTURE,
  FOLLOWS_FIXTURE,
  LEADS_FIXTURE,
  TASKS_FIXTURE,
} from '@/lib/crm/api/mock-data'

const TEST_USER = 'u-001'

describe('MockCrmClient · Customer', () => {
 let client: MockCrmClient

 beforeEach(() => {
 if (typeof window !== 'undefined') {
 window.localStorage.clear()
 }
 client = new MockCrmClient(TEST_USER)
 })

 it('listCustomers returns paginated 100 fixture rows by default', async () => {
 const page = await client.listCustomers({ page: 1, pageSize: 20 })
 expect(page.total).toBe(CUSTOMERS_FIXTURE.length)
 expect(page.items).toHaveLength(20)
 expect(page.page).toBe(1)
 })

 it('listCustomers keyword search matches name/phone/contact', async () => {
 const target = CUSTOMERS_FIXTURE[0]
 const page = await client.listCustomers({ keyword: target.name.slice(0, 3), pageSize: 50 })
 expect(page.items.some((c) => c.id === target.id)).toBe(true)
 })

 it('listCustomers scope=mine filters by current user', async () => {
 const all = await client.listCustomers({ scope: 'all', pageSize: 100 })
 const mine = await client.listCustomers({ scope: 'mine', pageSize: 100 })
 expect(mine.total).toBeLessThanOrEqual(all.total)
 mine.items.forEach((c) => expect(c.ownerId).toBe(TEST_USER))
 })

 it('listCustomers filter eq status=active works', async () => {
 const page = await client.listCustomers({
 filters: [{ field: 'status', op: 'eq', value: 'active' }],
 pageSize: 100,
 })
 page.items.forEach((c) => expect(c.status).toBe('active'))
 })

 it('listCustomers filter is_null ownerId = sea', async () => {
 const page = await client.listCustomers({
 filters: [{ field: 'ownerId', op: 'is_null', value: null }],
 pageSize: 100,
 })
 expect(page.items.length).toBeGreaterThan(0)
 page.items.forEach((c) => expect(c.ownerId).toBeNull())
 })

 it('listCustomers sortBy amount desc returns sorted items', async () => {
 const page = await client.listCustomers({
 sortBy: 'annualRevenue',
 sortOrder: 'desc',
 pageSize: 100,
 })
 const amounts = page.items.map((c) => c.annualRevenue ?? 0)
 for (let i = 1; i < amounts.length; i++) {
 expect(amounts[i - 1]).toBeGreaterThanOrEqual(amounts[i])
 }
 })

 it('getCustomer returns full entity', async () => {
 const target = CUSTOMERS_FIXTURE[0]
 const c = await client.getCustomer(target.id)
 expect(c.id).toBe(target.id)
 expect(c.name).toBe(target.name)
 })

 it('getCustomer throws on unknown id', async () => {
 await expect(client.getCustomer('nonexistent')).rejects.toThrow(/客户不存在/)
 })

 it('createCustomer assigns id and timestamps', async () => {
 const created = await client.createCustomer({
 name: '测试新客户',
 rating: 'B',
 status: 'active',
 source: 'other',
 ownerId: TEST_USER,
 })
 expect(created.id).toMatch(/^c-/)
 expect(created.ownerId).toBe(TEST_USER)
 expect(created.createdAt).toBeTruthy()
 })

 it('updateCustomer mutates fields and bumps updatedAt', async () => {
 const target = CUSTOMERS_FIXTURE[0]
 const updated = await client.updateCustomer(target.id, { remark: 'updated remark' })
 expect(updated.remark).toBe('updated remark')
 expect(updated.updatedAt >= target.updatedAt).toBe(true)
 })

 it('deleteCustomer removes entity and its follows', async () => {
 const target = CUSTOMERS_FIXTURE.find((c) =>
 FOLLOWS_FIXTURE.some((f) => f.entityType === 'customer' && f.entityId === c.id),
 )
 if (!target) return
 await client.deleteCustomer(target.id)
 await expect(client.getCustomer(target.id)).rejects.toThrow()
 })

 it('batchMoveToSea sets ownerId=null on selected ids', async () => {
 const ids = CUSTOMERS_FIXTURE.slice(0, 3).map((c) => c.id)
 await client.batchMoveToSea(ids)
 const after = await client.listCustomers({ scope: 'all', pageSize: 100, filters: [{ field: 'id', op: 'in', value: ids }] })
 expect(after.items).toHaveLength(3)
 after.items.forEach((c) => expect(c.ownerId).toBeNull())
 })

 it('batchTransferCustomers reassigns owner', async () => {
 const target = CUSTOMERS_FIXTURE[0]
 const newOwner = 'u-002'
 await client.batchTransferCustomers([target.id], newOwner)
 const after = await client.getCustomer(target.id)
 expect(after.ownerId).toBe(newOwner)
 })

 it('claimFromSea assigns current user as owner', async () => {
 const seaCustomer = CUSTOMERS_FIXTURE.find((c) => c.ownerId === null)
 if (!seaCustomer) return
 const claimed = await client.claimFromSea(seaCustomer.id)
 expect(claimed.ownerId).toBe(TEST_USER)
 })

 it("listCustomers scope='sea' returns only ownerId=null customers", async () => {
 const page = await client.listCustomers({ scope: 'sea', pageSize: 100 })
 expect(page.items.length).toBeGreaterThan(0)
 page.items.forEach((c) => expect(c.ownerId).toBeNull())
 // sea 与 all 不相交
 const all = await client.listCustomers({ scope: 'all', pageSize: 100 })
 const seaIds = new Set(page.items.map((c) => c.id))
 all.items.forEach((c) => expect(seaIds.has(c.id)).toBe(c.ownerId === null))
 })
})

describe('MockCrmClient · Lead', () => {
 let client: MockCrmClient

 beforeEach(() => {
 if (typeof window !== 'undefined') {
 window.localStorage.clear()
 }
 client = new MockCrmClient(TEST_USER)
 })

 it('listLeads returns 50 fixture rows', async () => {
 const page = await client.listLeads({ pageSize: 100 })
 expect(page.total).toBe(LEADS_FIXTURE.length)
 })

 it('createLead + updateLead round-trip', async () => {
 const lead = await client.createLead({
 name: '测试线索',
 company: '某公司',
 phone: '13800000000',
 source: 'other',
 status: 'new',
 intent: 'medium',
 ownerId: TEST_USER,
 })
 expect(lead.id).toMatch(/^l-/)
 const updated = await client.updateLead(lead.id, { status: 'contacting' })
 expect(updated.status).toBe('contacting')
 })

 it('convertLead creates a customer and marks lead as converted', async () => {
 const lead = LEADS_FIXTURE.find((l) => l.status !== 'converted' && l.status !== 'discarded')
 if (!lead) return
 const { customer, lead: updated } = await client.convertLead(lead.id, { name: '转化客户-X' })
 expect(customer.id).toMatch(/^c-/)
 expect(customer.contactName).toBe(lead.name)
 expect(updated.status).toBe('converted')
 expect(updated.convertedToCustomerId).toBe(customer.id)
 })

 it('convertLead rejects already-converted leads', async () => {
 const already = LEADS_FIXTURE.find((l) => l.status === 'converted')
 if (!already) return
 await expect(client.convertLead(already.id)).rejects.toThrow(/已转化/)
 })
})

describe('MockCrmClient · Follow', () => {
 it('listFollows filters by entity', async () => {
 const client = new MockCrmClient(TEST_USER)
 const follows = await client.listFollows('customer', CUSTOMERS_FIXTURE[0].id)
 expect(Array.isArray(follows)).toBe(true)
 })

 it('createFollow bumps customer.lastFollowAt', async () => {
 const client = new MockCrmClient(TEST_USER)
 const target = CUSTOMERS_FIXTURE[0]
 const before = await client.getCustomer(target.id)
 const follow = await client.createFollow({
 entityType: 'customer',
 entityId: target.id,
 type: 'phone',
 content: '测试跟进',
 createdBy: TEST_USER,
 })
 expect(follow.id).toMatch(/^f-/)
 const after = await client.getCustomer(target.id)
 expect(after.lastFollowAt).toBeTruthy()
 expect((after.lastFollowAt ?? '') >= (before.lastFollowAt ?? '')).toBe(true)
 })
})

describe('MockCrmClient · User', () => {
 it('listUsers returns 10 fixture rows', async () => {
 const client = new MockCrmClient(TEST_USER)
 const users = await client.listUsers()
 expect(users).toHaveLength(10)
 })

 it('getUser throws on unknown id', async () => {
 const client = new MockCrmClient(TEST_USER)
 await expect(client.getUser('nonexistent')).rejects.toThrow(/用户不存在/)
 })
})
describe('MockCrmClient · Task (P7)', () => {
  let client: MockCrmClient

  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.clear()
    }
    client = new MockCrmClient(TEST_USER)
  })

  it('listTasks returns all fixture rows by default', async () => {
    const page = await client.listTasks({ page: 1, pageSize: 100 })
    expect(page.total).toBe(TASKS_FIXTURE.length)
    expect(page.items.every((t) => t.id.startsWith('t-'))).toBe(true)
  })

  it('listTasks type 筛选只返回该类型', async () => {
    const page = await client.listTasks({ type: 'call', pageSize: 100 })
    expect(page.total).toBeGreaterThan(0)
    page.items.forEach((t) => expect(t.type).toBe('call'))
  })

  it('listTasks status 筛选只返回该状态', async () => {
    const page = await client.listTasks({ status: 'cancelled', pageSize: 100 })
    page.items.forEach((t) => expect(t.status).toBe('cancelled'))
  })

  it('listTasks scope=mine 只返回当前用户任务', async () => {
    const mine = await client.listTasks({ scope: 'mine', pageSize: 100 })
    const all = await client.listTasks({ scope: 'all', pageSize: 100 })
    expect(mine.total).toBeLessThanOrEqual(all.total)
    mine.items.forEach((t) => expect(t.ownerId).toBe(TEST_USER))
  })

  it('listTasks 默认按 due_date 升序、无截止排最后', async () => {
    const page = await client.listTasks({ pageSize: 100 })
    const withDue = page.items.filter((t) => t.dueDate)
    const times = withDue.map((t) => new Date(t.dueDate as string).getTime())
    const sorted = [...times].sort((a, b) => a - b)
    expect(times).toEqual(sorted)
    // 无截止的在最后
    const hasNone = page.items.some((t) => !t.dueDate)
    if (hasNone) {
      const lastNone = [...page.items].reverse().findIndex((t) => !t.dueDate)
      expect(lastNone).toBeGreaterThanOrEqual(0)
    }
  })

  it('setTaskStatus 流转状态并回写 completed_at', async () => {
    const target = TASKS_FIXTURE.find((t) => t.status === 'pending')
    expect(target).toBeTruthy()
    const updated = await client.setTaskStatus(target!.id, 'done')
    expect(updated.status).toBe('done')
    expect(updated.completedAt).toBeTruthy()
    // 再查列表已更新
    const page = await client.listTasks({ status: 'done', pageSize: 100 })
    expect(page.items.some((t) => t.id === target!.id)).toBe(true)
  })

  it('setTaskStatus 未知任务抛错', async () => {
    await expect(client.setTaskStatus('t-9999', 'done')).rejects.toThrow(/任务不存在/)
  })
})

describe('MockCrmClient · Task 创建/编辑/完成/取消（BLF-514）', () => {
  let client: MockCrmClient

  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.clear()
    }
    client = new MockCrmClient(TEST_USER)
  })

  it('createTask 默认 owner=当前用户，返回完整实体', async () => {
    const created = await client.createTask({
      title: '测试新建任务',
      type: 'call',
      priority: 'high',
    })
    expect(created.id).toMatch(/^t-/)
    expect(created.ownerId).toBe(TEST_USER)
    expect(created.status).toBe('pending')
    expect(created.type).toBe('call')
    expect(created.priority).toBe('high')
    // 已入列表
    const page = await client.listTasks({ pageSize: 100 })
    expect(page.items.some((t) => t.id === created.id)).toBe(true)
  })

  it('createTask 关联客户时回填 customerName', async () => {
    const target = CUSTOMERS_FIXTURE[0]
    const created = await client.createTask({
      title: '关联客户任务',
      type: 'follow_up',
      priority: 'medium',
      customerId: target.id,
    })
    expect(created.customerId).toBe(target.id)
    expect(created.customerName).toBe(target.name)
  })

  it('updateTask 修改字段并 bump updatedAt', async () => {
    const target = TASKS_FIXTURE[0]
    const updated = await client.updateTask(target.id, {
      title: '改后的标题',
      priority: 'urgent',
    })
    expect(updated.title).toBe('改后的标题')
    expect(updated.priority).toBe('urgent')
    expect(updated.updatedAt >= target.updatedAt).toBe(true)
  })

  it('completeTask 置 done + completed_at', async () => {
    const target = TASKS_FIXTURE.find((t) => t.status === 'pending')!
    const updated = await client.completeTask(target.id)
    expect(updated.status).toBe('done')
    expect(updated.completedAt).toBeTruthy()
    const page = await client.listTasks({ status: 'done', pageSize: 100 })
    expect(page.items.some((t) => t.id === target.id)).toBe(true)
  })

  it('cancelTask 置 cancelled 并清空 completed_at', async () => {
    const target = TASKS_FIXTURE.find((t) => t.status === 'pending')!
    const done = await client.completeTask(target.id)
    expect(done.completedAt).toBeTruthy()
    const cancelled = await client.cancelTask(target.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.completedAt).toBeUndefined()
  })

  it('操作未知任务抛错', async () => {
    await expect(client.completeTask('t-9999')).rejects.toThrow(/任务不存在/)
    await expect(client.cancelTask('t-9998')).rejects.toThrow(/任务不存在/)
    await expect(client.updateTask('t-9997', { title: 'x' })).rejects.toThrow(/任务不存在/)
  })
})

describe('MockCrmClient · 漏斗二层复盘面板 getFunnelStageDetail (BLF-518)', () => {
  let client: MockCrmClient

  beforeEach(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.clear()
    }
    client = new MockCrmClient(TEST_USER)
  })

  it('返回指定阶段的线索明细，count = 该状态线索数', async () => {
    const expectedCount = LEADS_FIXTURE.filter((l) => l.status === 'contacting').length
    const d = await client.getFunnelStageDetail({ stage: 'contacting' })
    expect(d.stage).toBe('contacting')
    expect(d.count).toBe(expectedCount)
    expect(d.total).toBe(expectedCount)
    expect(d.stuckDays).toBe(7)
    expect(d.leads.every((l) => l.id.startsWith('l-'))).toBe(true)
  })

  it('默认按停留时长降序（卡最久在前）', async () => {
    const d = await client.getFunnelStageDetail({ stage: 'qualified' })
    const dwells = d.leads.map((l) => l.dwellDays ?? 0)
    expect([...dwells]).toEqual([...dwells].sort((a, b) => b - a))
  })

  it('sort_by=recent 按最后动作倒序', async () => {
    const d = await client.getFunnelStageDetail({ stage: 'qualified', sortBy: 'recent' })
    const times = d.leads.map((l) => l.lastActionAt ?? '')
    expect([...times]).toEqual([...times].sort((a, b) => b.localeCompare(a)))
  })

  it('isStuck 阈值 = dwell > stuckDays，stuckCount 汇总正确', async () => {
    const d = await client.getFunnelStageDetail({ stage: 'new', stuckDays: 5 })
    const stuckLeads = d.leads.filter((l) => l.isStuck)
    expect(stuckLeads.every((l) => (l.dwellDays ?? 0) > 5)).toBe(true)
    expect(d.stuckCount).toBeGreaterThanOrEqual(stuckLeads.length)
  })

  it('分页生效：page_size=5 返回 5 条且 total 不变', async () => {
    const d = await client.getFunnelStageDetail({ stage: 'contacting', page: 1, pageSize: 5 })
    expect(d.leads.length).toBeLessThanOrEqual(5)
    expect(d.pageSize).toBe(5)
    expect(d.page).toBe(1)
  })

  it('未知阶段返回空明细（count=0）', async () => {
    const d = await client.getFunnelStageDetail({ stage: 'nope' })
    expect(d.count).toBe(0)
    expect(d.leads).toHaveLength(0)
  })
})
