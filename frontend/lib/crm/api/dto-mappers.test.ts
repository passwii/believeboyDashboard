import { describe, expect, it } from 'vitest'
import {
  mapCustomer,
  mapFollow,
  mapFollowUp,
  mapFollowUpGroups,
  mapFunnelStageDetail,
  mapLead,
  mapLifecycleBoard,
  mapTask,
  mapUser,
  toConvertPayload,
  toCustomerPayload,
  toFollowPayload,
  toImportRowPayload,
  toLeadPayload,
  toTaskPayload,
  type CustomerDto,
  type FollowDto,
  type FollowUpGroupsDto,
  type LeadDto,
  type LifecycleBoardDto,
  type StageDetailDto,
  type TaskDto,
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

describe('mapTask (P7)', () => {
  it('int 主键转 string、snake 转 camel、联查名映射', () => {
    const dto: TaskDto = {
      id: 9,
      title: '确认报价单',
      due_date: '2026-08-10T00:00:00+00:00',
      priority: 'high',
      status: 'in_progress',
      type: 'follow_up',
      owner_id: 'uuid-1',
      owner_name: '张三',
      customer_id: 42,
      customer_name: '某工厂',
      lead_id: null,
      created_by: 'uuid-9',
      completed_at: null,
      created_at: '2026-08-01T00:00:00+00:00',
      updated_at: '2026-08-02T00:00:00+00:00',
    }
    const t = mapTask(dto)
    expect(t.id).toBe('9')
    expect(t.customerId).toBe('42')
    expect(t.customerName).toBe('某工厂')
    expect(t.ownerName).toBe('张三')
    expect(t.priority).toBe('high')
    expect(t.type).toBe('follow_up')
    expect(t.dueDate).toBe('2026-08-10T00:00:00+00:00')
    expect(t.leadId).toBeUndefined()
    expect(t.completedAt).toBeUndefined()
  })
  it('ownerId 保留 null；线索关联映射', () => {
    const dto: TaskDto = {
      id: 3,
      title: '电话回访',
      priority: 'medium',
      status: 'pending',
      type: 'call',
      owner_id: null,
      lead_id: 7,
      lead_name: '王五',
      created_at: '2026-08-01T00:00:00+00:00',
      updated_at: '2026-08-01T00:00:00+00:00',
    }
    const t = mapTask(dto)
    expect(t.ownerId).toBeNull()
    expect(t.ownerName).toBeUndefined()
    expect(t.leadId).toBe('7')
    expect(t.leadName).toBe('王五')
    expect(t.customerId).toBeUndefined()
  })
})

describe('入站映射', () => {
  it('toTaskPayload 驼峰转下划线、id 转 int、undefined 剔除', () => {
    const p = toTaskPayload({
      title: '确认报价单',
      type: 'follow_up',
      priority: 'high',
      dueDate: '2026-08-10T00:00:00+00:00',
      customerId: '42',
      ownerId: 'uuid-1',
    })
    expect(p).toEqual({
      title: '确认报价单',
      type: 'follow_up',
      priority: 'high',
      due_date: '2026-08-10T00:00:00+00:00',
      customer_id: 42,
      owner_id: 'uuid-1',
    })
    expect(p).not.toHaveProperty('lead_id')
  })
  it('toTaskPayload leadId 转 int、可空字段缺省剔除', () => {
    const p = toTaskPayload({ title: 'x', leadId: '7' })
    expect(p.lead_id).toBe(7)
    expect(p).not.toHaveProperty('customer_id')
  })

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

describe('mapFunnelStageDetail（漏斗二层复盘面板，BLF-518）', () => {
  const stageDto: StageDetailDto = {
    stage: 'contacting',
    count: 2,
    avg_dwell_days: 5.4,
    stuck_count: 1,
    inflow: 2,
    outflow: 3,
    stuck_days: 7,
    page: 1,
    page_size: 10,
    total: 2,
    leads: [
      {
        id: 7,
        name: '王五',
        company: '某贸易',
        owner_id: 'uuid-1',
        owner_name: '张三',
        source: 'referral',
        intent: 'high',
        entered_stage_at: '2026-08-01T00:00:00+00:00',
        last_action_at: '2026-08-02T00:00:00+00:00',
        last_action_content: '电话沟通 30 分钟',
        next_follow_at: '2026-08-10T00:00:00+00:00',
        dwell_days: 7.5,
        is_stuck: true,
      },
      {
        id: 8,
        name: '李四',
        owner_id: null,
        dwell_days: null,
        is_stuck: false,
      },
    ],
  }

  it('int 主键转 string、snake 转 camel、null → undefined', () => {
    const d = mapFunnelStageDetail(stageDto)
    expect(d.stage).toBe('contacting')
    expect(d.count).toBe(2)
    expect(d.avgDwellDays).toBe(5.4)
    expect(d.stuckCount).toBe(1)
    expect(d.inflow).toBe(2)
    expect(d.outflow).toBe(3)
    expect(d.stuckDays).toBe(7)
    expect(d.page).toBe(1)
    expect(d.pageSize).toBe(10)
    expect(d.total).toBe(2)
  })

  it('leads 逐条映射：id/name/owner/dwell/isStuck + 可空字段缺省', () => {
    const d = mapFunnelStageDetail(stageDto)
    expect(d.leads).toHaveLength(2)
    const first = d.leads[0]
    expect(first.id).toBe('7')
    expect(first.name).toBe('王五')
    expect(first.company).toBe('某贸易')
    expect(first.ownerId).toBe('uuid-1')
    expect(first.ownerName).toBe('张三')
    expect(first.source).toBe('referral')
    expect(first.intent).toBe('high')
    expect(first.enteredStageAt).toBe('2026-08-01T00:00:00+00:00')
    expect(first.lastActionAt).toBe('2026-08-02T00:00:00+00:00')
    expect(first.lastActionContent).toBe('电话沟通 30 分钟')
    expect(first.nextFollowAt).toBe('2026-08-10T00:00:00+00:00')
    expect(first.dwellDays).toBe(7.5)
    expect(first.isStuck).toBe(true)

    const second = d.leads[1]
    expect(second.id).toBe('8')
    expect(second.company).toBeUndefined()
    expect(second.ownerId).toBeNull()
    expect(second.ownerName).toBeUndefined()
    expect(second.enteredStageAt).toBeUndefined()
    expect(second.lastActionAt).toBeUndefined()
    expect(second.dwellDays).toBeUndefined()
    expect(second.isStuck).toBe(false)
  })

  it('outflow / avgDwellDays 为 null 时转 undefined', () => {
    const d = mapFunnelStageDetail({ ...stageDto, outflow: null, avg_dwell_days: null, leads: [] })
    expect(d.outflow).toBeUndefined()
    expect(d.avgDwellDays).toBeUndefined()
  })
})

describe('mapLifecycleBoard（生命周期看板，BLF-520）', () => {
  const boardDto: LifecycleBoardDto = {
    first_follow: {
      metric: 'first_follow',
      label: '首次跟进',
      description: '客户创建 → 第一条跟进记录',
      buckets: [
        { label: '1 天内', min_days: 0, max_days: 1, count: 3, pct: 0.6, cumulative_pct: 0.6 },
        { label: '30 天以上', min_days: 30, max_days: null, count: 2, pct: 0.4, cumulative_pct: 1.0 },
      ],
      summary: { sample_count: 5, total_count: 8, avg_days: 2.5, median_days: 1.0, p90_days: 9.9, max_days: 40.0 },
    },
    conversion: {
      metric: 'conversion',
      label: '转化',
      description: '线索创建 → 转化完成（线索转客户）',
      buckets: [],
      summary: { sample_count: 0, total_count: 10 },
    },
    churn: {
      metric: 'churn',
      label: '流失',
      description: '客户创建 → 首次回公海',
      buckets: [],
      summary: { sample_count: 0, total_count: 8 },
    },
    now_in_sea: 2,
  }

  it('snake → camel、null → undefined、nowInSea 透传', () => {
    const board = mapLifecycleBoard(boardDto)
    expect(board.nowInSea).toBe(2)
    expect(board.firstFollow.metric).toBe('first_follow')
    expect(board.firstFollow.label).toBe('首次跟进')
    expect(board.firstFollow.summary.sampleCount).toBe(5)
    expect(board.firstFollow.summary.totalCount).toBe(8)
    expect(board.firstFollow.summary.avgDays).toBe(2.5)
    expect(board.firstFollow.buckets[0]?.maxDays).toBe(1)
    expect(board.firstFollow.buckets[0]?.cumulativePct).toBe(0.6)
    expect(board.firstFollow.buckets[1]?.maxDays).toBeUndefined()
    expect(board.firstFollow.buckets[1]?.cumulativePct).toBe(1.0)
    expect(board.conversion.summary.sampleCount).toBe(0)
    expect(board.churn.summary.totalCount).toBe(8)
  })
})
