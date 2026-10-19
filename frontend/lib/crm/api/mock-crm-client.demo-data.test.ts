import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MockCrmClient } from '@/lib/crm/api/mock-crm-client'
import {
  CUSTOMERS_FIXTURE,
  LEADS_FIXTURE,
  FOLLOWS_FIXTURE,
  TASKS_FIXTURE,
  PROPOSALS_FIXTURE,
} from '@/lib/crm/api/mock-data'
import type { Customer, Lead } from '@/lib/crm/types'

/**
 * BLF-1372：CRM 客户 / 线索列表不得再混入演示（mock）夹具数据。
 *
 * 之前 MockCrmClient 无条件把 100 客户 / 50 线索等夹具灌进状态，生产构建
 * （`NEXT_PUBLIC_CRM_API_MODE` 未设置 → mock）里用户和自己录入的数据混在一起，
 * 无法「只删 mock、留自己的」。
 *
 * 本文件只测演示数据的开关与存量清理，其余 mock 行为仍由
 * `mock-crm-client.test.ts` 覆盖（那里保留演示数据，跑在非 production 环境）。
 */

const STORAGE_KEY = 'believeboy-crm-mock-state-v1'
const TEST_USER = 'u-001'

/** 造一条用户自己新建 / 导入的客户（id 形如 `genId()`，不属于夹具集合）。 */
function makeUserCustomer(id: string, name: string): Customer {
  return {
    id,
    name,
    rating: 'B',
    categories: [],
    status: 'active',
    source: 'other',
    ownerId: TEST_USER,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    createdBy: TEST_USER,
  }
}

function makeUserLead(id: string, name: string): Lead {
  return {
    id,
    name,
    source: 'other',
    status: 'new',
    intent: 'medium',
    ownerId: TEST_USER,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

describe('MockCrmClient · 演示数据开关（BLF-1372）', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('生产构建（无演示数据开关）新会话不灌夹具：客户 / 线索 / 跟进 / 任务 / 方案均为空', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_DEMO_DATA', '0')
    const client = new MockCrmClient(TEST_USER)

    expect((await client.listCustomers({ pageSize: 100 })).total).toBe(0)
    expect((await client.listLeads({ pageSize: 100 })).total).toBe(0)
    expect((await client.listTasks({ pageSize: 100 })).total).toBe(0)
    expect((await client.listProposals({ pageSize: 100 })).total).toBe(0)
    expect(await client.listFollows('customer', 'c-0001')).toEqual([])
  })

  it('NODE_ENV=production 且未设开关时默认不灌夹具（Vercel 生产构建的实际路径）', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const client = new MockCrmClient(TEST_USER)

    expect((await client.listCustomers({ pageSize: 100 })).total).toBe(0)
    expect((await client.listLeads({ pageSize: 100 })).total).toBe(0)
  })

  it('保留用户自建数据：新建客户 / 线索后仍能读回', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_DEMO_DATA', '0')
    const client = new MockCrmClient(TEST_USER)

    const customer = await client.createCustomer({
      name: '我自己上传的客户',
      rating: 'A',
      status: 'active',
      source: 'other',
      ownerId: TEST_USER,
    })
    const lead = await client.createLead({
      name: '我自己上传的线索',
      source: 'other',
      status: 'new',
      intent: 'high',
      ownerId: TEST_USER,
    })

    expect((await client.listCustomers({ pageSize: 100 })).items.map((c) => c.id)).toEqual([
      customer.id,
    ])
    expect((await client.listLeads({ pageSize: 100 })).items.map((l) => l.id)).toEqual([lead.id])
  })

  it('开发 / 测试环境（未设开关）仍灌演示夹具，E2E 与本地开发不受影响', async () => {
    const client = new MockCrmClient(TEST_USER)
    expect((await client.listCustomers({ pageSize: 200 })).total).toBe(CUSTOMERS_FIXTURE.length)
    expect((await client.listLeads({ pageSize: 200 })).total).toBe(LEADS_FIXTURE.length)
  })

  it('显式 NEXT_PUBLIC_CRM_DEMO_DATA=1 可在预览环境恢复演示数据', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_DEMO_DATA', '1')
    vi.stubEnv('NODE_ENV', 'production')
    const client = new MockCrmClient(TEST_USER)
    expect((await client.listCustomers({ pageSize: 200 })).total).toBe(CUSTOMERS_FIXTURE.length)
  })
})

describe('MockCrmClient · 存量演示数据清理（BLF-1372）', () => {
  const userCustomer = makeUserCustomer('c-mock1372-a1b2c3', '我自己的客户')
  const userLead = makeUserLead('l-mock1372-d4e5f6', '我自己的线索')

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubEnv('NEXT_PUBLIC_CRM_DEMO_DATA', '0')

    // 模拟旧版本写进 localStorage 的状态：夹具 + 用户数据混存
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        customers: [...CUSTOMERS_FIXTURE, userCustomer],
        leads: [...LEADS_FIXTURE, userLead],
        // 一条夹具跟进 + 一条用户自建（挂在自己的客户上）的跟进
        follows: [
          ...FOLLOWS_FIXTURE,
          {
            id: 'f-mock1372-aaaaaa',
            entityType: 'customer',
            entityId: userCustomer.id,
            type: 'note',
            content: '我自己的跟进',
            createdBy: TEST_USER,
            createdAt: '2026-10-02T00:00:00.000Z',
          },
        ],
        contacts: [
          // 挂在演示客户上的联系人应随之清理
          {
            id: 'ct-mock1372-bbbbbb',
            customerId: CUSTOMERS_FIXTURE[0].id,
            name: '演示客户联系人',
            isPrimary: true,
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
          {
            id: 'ct-mock1372-cccccc',
            customerId: userCustomer.id,
            name: '我的联系人',
            isPrimary: true,
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
        ],
        users: [],
        categories: [],
        audits: [],
        tasks: [...TASKS_FIXTURE],
        rules: [],
        proposals: [...PROPOSALS_FIXTURE],
        proposalVersions: [],
        proposalBodies: {},
        workflowSettings: { staleDays: 7, staleEmailEnabled: true },
      })
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('只删演示夹具，保留用户自己上传的客户 / 线索 / 跟进 / 联系人', async () => {
    const client = new MockCrmClient(TEST_USER)

    const customers = await client.listCustomers({ pageSize: 200 })
    expect(customers.items.map((c) => c.id)).toEqual([userCustomer.id])

    const leads = await client.listLeads({ pageSize: 200 })
    expect(leads.items.map((l) => l.id)).toEqual([userLead.id])

    expect((await client.listTasks({ pageSize: 200 })).total).toBe(0)
    expect((await client.listProposals({ pageSize: 200 })).total).toBe(0)

    const customerFollows = await client.listFollows('customer', userCustomer.id)
    expect(customerFollows.map((f) => f.content)).toEqual(['我自己的跟进'])

    const contacts = await client.listContacts(userCustomer.id)
    expect(contacts.map((c) => c.name)).toEqual(['我的联系人'])
  })

  it('清理结果回写 localStorage，二次加载不再包含夹具', () => {
    // 第一个实例触发迁移并回写
    void new MockCrmClient(TEST_USER)
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')

    expect(persisted.customers.map((c: Customer) => c.id)).toEqual([userCustomer.id])
    expect(persisted.leads.map((l: Lead) => l.id)).toEqual([userLead.id])
    expect(persisted.tasks).toEqual([])
    expect(persisted.proposals).toEqual([])
    // 夹具跟进全部清掉，只剩用户那条
    expect(persisted.follows).toHaveLength(1)
    expect(persisted.follows[0].id).toBe('f-mock1372-aaaaaa')
  })

  it('迁移幂等：重复加载不会误删用户数据', async () => {
    const first = new MockCrmClient(TEST_USER)
    void first
    const second = new MockCrmClient(TEST_USER)
    const again = await second.listCustomers({ pageSize: 200 })
    expect(again.items.map((c) => c.id)).toEqual([userCustomer.id])
    expect((await second.listLeads({ pageSize: 200 })).items.map((l) => l.id)).toEqual([userLead.id])
  })
})
