import { describe, expect, it } from 'vitest'
import {
  mapCustomer,
  mapFollow,
  mapFollowUp,
  mapFollowUpGroups,
  mapLead,
  mapUser,
  toConvertPayload,
  toCustomerPayload,
  toFollowPayload,
  toImportRowPayload,
  toLeadPayload,
  type CustomerDto,
  type FollowDto,
  type FollowUpGroupsDto,
  type LeadDto,
} from './dto-mappers'

const customerDto: CustomerDto = {
  id: 42,
  name: '某工厂',
  customer_type: '工厂',
  interested_service: '代运营',
  rating: 'A',
  status: 'active',
  source: 'referral',
  owner_id: 'uuid-1',
  owner_name: '张三',
  contact_name: '李四',
  annual_revenue: 100.5,
  created_by: 'uuid-9',
  created_at: '2026-07-23T00:00:00+00:00',
  updated_at: '2026-07-23T00:00:00+00:00',
  last_follow_at: null,
}

const leadDto: LeadDto = {
  id: 7,
  name: '王五',
  company: '某贸易',
  wechat: 'wx-1',
  status: 'new',
  intent: 'high',
  customer_type: '贸易商',
  interested_service: 'AI运营',
  owner_id: null,
  converted_to_customer_id: 42,
  created_at: '2026-07-23T00:00:00+00:00',
  updated_at: '2026-07-23T00:00:00+00:00',
}

describe('mapCustomer', () => {
  it('int 主键转 string、snake 转 camel、新字段映射', () => {
    const c = mapCustomer(customerDto)
    expect(c.id).toBe('42')
    expect(c.customerType).toBe('工厂')
    expect(c.interestedService).toBe('代运营')
    expect(c.ownerId).toBe('uuid-1')
    expect(c.contactName).toBe('李四')
    expect(c.annualRevenue).toBe(100.5)
    expect(c.createdBy).toBe('uuid-9')
  })
  it('null → undefined / ownerId 保留 null', () => {
    const c = mapCustomer({ ...customerDto, owner_id: null, short_name: null })
    expect(c.ownerId).toBeNull()
    expect(c.shortName).toBeUndefined()
    expect(c.lastFollowAt).toBeUndefined()
  })
})

describe('mapLead', () => {
  it('映射新字段与转化字段', () => {
    const l = mapLead(leadDto)
    expect(l.id).toBe('7')
    expect(l.customerType).toBe('贸易商')
    expect(l.interestedService).toBe('AI运营')
    expect(l.wechat).toBe('wx-1')
    expect(l.ownerId).toBeNull()
    expect(l.convertedToCustomerId).toBe('42')
  })
})

describe('mapFollow', () => {
  it('entity_id 转 string、type 映射', () => {
    const dto: FollowDto = {
      id: 1,
      entity_type: 'customer',
      entity_id: 42,
      type: 'phone',
      content: '电话',
      created_by: 'uuid-1',
      created_by_name: '张三',
      created_at: '2026-07-23T00:00:00+00:00',
    }
    const f = mapFollow(dto)
    expect(f.entityId).toBe('42')
    expect(f.entityType).toBe('customer')
    expect(f.type).toBe('phone')
    expect(f.createdByName).toBe('张三')
  })
})

describe('mapUser', () => {
  it('role_type 缺省回退 operator', () => {
    expect(mapUser({ id: 'u1', name: 'a', email: 'a@x.com', is_active: true }).roleType).toBe(
      'operator'
    )
  })
})

describe('入站映射', () => {
  it('toCustomerPayload 携带 contact 字段（修复丢失联系人）', () => {
    const p = toCustomerPayload({
      name: 'X',
      contactName: '张三',
      contactPhone: '138',
      contactEmail: 'a@b.com',
    })
    expect(p.contact_name).toBe('张三')
    expect(p.contact_phone).toBe('138')
    expect(p.contact_email).toBe('a@b.com')
  })
  it('toImportRowPayload 驼峰转下划线并剔除 undefined', () => {
    const p = toImportRowPayload({
      name: '导入户',
      rating: 'A',
      customerType: '工厂',
      contactName: '李四',
      annualRevenue: 1000,
    })
    expect(p).toEqual({
      name: '导入户',
      rating: 'A',
      customer_type: '工厂',
      contact_name: '李四',
      annual_revenue: 1000,
    })
    expect(p).not.toHaveProperty('short_name')
  })
  it('toLeadPayload camel→snake', () => {
    const p = toLeadPayload({
      name: 'x',
      interestedService: '代运营',
      expectedAmount: 1000,
    } as never)
    expect(p).toEqual({ name: 'x', interested_service: '代运营', expected_amount: 1000 })
  })
  it('toFollowPayload entity_id 转 int、不带 created_by', () => {
    const p = toFollowPayload({
      entityType: 'lead',
      entityId: '7',
      type: 'wechat',
      content: '微信',
      createdBy: 'uuid-1',
    } as never)
    expect(p).toEqual({ entity_type: 'lead', entity_id: 7, type: 'wechat', content: '微信' })
    expect(p).not.toHaveProperty('created_by')
  })
  it('toConvertPayload 仅保留可覆盖字段，空则 undefined', () => {
    expect(toConvertPayload(undefined)).toBeUndefined()
    expect(toConvertPayload({})).toBeUndefined()
    expect(toConvertPayload({ name: 'n', rating: 'A' } as never)).toEqual({ name: 'n', rating: 'A' })
  })
})


describe('mapFollowUp / mapFollowUpGroups', () => {
  const groupsDto: FollowUpGroupsDto = {
    overdue: [
      {
        entity_type: 'customer',
        entity_id: 7,
        name: '逾期客户',
        subtitle: '五金',
        owner_id: 'uuid-1',
        owner_name: '张三',
        next_follow_at: '2026-07-20T10:00:00+00:00',
        last_follow_content: '上次电话',
        last_follow_at: '2026-07-19T10:00:00+00:00',
        rating: 'A',
        status: 'active',
        intent: null,
      },
    ],
    today: [
      {
        entity_type: 'lead',
        entity_id: 3,
        name: '今日线索',
        subtitle: '东莞五金厂',
        owner_id: null,
        owner_name: null,
        next_follow_at: '2026-07-22T12:00:00+08:00',
        last_follow_content: null,
        last_follow_at: null,
        rating: null,
        status: 'contacting',
        intent: 'high',
      },
    ],
    this_week: [],
    overdue_count: 1,
    total_count: 2,
  }

  it('maps a customer follow-up item (snake→camel, int→string, null→undefined)', () => {
    const item = mapFollowUp(groupsDto.overdue[0])
    expect(item.entityType).toBe('customer')
    expect(item.entityId).toBe('7')
    expect(item.name).toBe('逾期客户')
    expect(item.subtitle).toBe('五金')
    expect(item.ownerId).toBe('uuid-1')
    expect(item.ownerName).toBe('张三')
    expect(item.nextFollowAt).toBe('2026-07-20T10:00:00+00:00')
    expect(item.lastFollowContent).toBe('上次电话')
    expect(item.rating).toBe('A')
    expect(item.intent).toBeUndefined() // null → undefined
  })

  it('maps a lead follow-up item with null owner', () => {
    const item = mapFollowUp(groupsDto.today[0])
    expect(item.entityType).toBe('lead')
    expect(item.ownerId).toBeNull()
    expect(item.ownerName).toBeUndefined()
    expect(item.lastFollowContent).toBeUndefined()
    expect(item.intent).toBe('high')
    expect(item.rating).toBeUndefined()
  })

  it('maps groups recursively + counts', () => {
    const groups = mapFollowUpGroups(groupsDto)
    expect(groups.overdue).toHaveLength(1)
    expect(groups.today).toHaveLength(1)
    expect(groups.thisWeek).toHaveLength(0)
    expect(groups.overdueCount).toBe(1)
    expect(groups.totalCount).toBe(2)
    expect(groups.overdue[0].entityId).toBe('7')
    expect(groups.today[0].entityType).toBe('lead')
  })
})
