import { describe, expect, it, vi, afterEach, type Mock } from 'vitest'
import {
  deriveSla,
  fetchComplaintList,
  mapComplaintDetail,
  mapComplaintItem,
  type ComplaintBackendItem,
} from '../complaint-api'

/** 后端真实返回形状（backend/app/schemas/complaint_center.py ComplaintListItem）。 */
function backendItem(overrides: Partial<ComplaintBackendItem> = {}): ComplaintBackendItem {
  return {
    id: 1,
    run_id: 2,
    project_id: 18,
    country: 'US',
    buyer_name: 'Crystal',
    message_date: '2026-09-02',
    subject: 'Product details inquiry',
    category: 'with_order',
    has_order: true,
    status: 'pending',
    order_info: {
      order_id: '112-8707798-7079456',
      asin: 'B0CR19VKBX',
      product_title: 'Electric Blanket Twin',
      qty: 1,
      purchased_at: null,
      shipped_at: null,
      delivered_at: null,
    },
    created_at: '2026-09-04T10:00:00+00:00',
    updated_at: '2026-09-04T10:00:00+00:00',
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('deriveSla', () => {
  it('已回复及之后的状态 → 已关闭 / closed（即使 SLA 已过期）', () => {
    const past = { reply_deadline: '2000-01-01T00:00:00Z', expires_soon: false }
    expect(deriveSla('replied', past)).toEqual({ sla_remaining: '已关闭', sla_level: 'closed' })
    expect(deriveSla('resolved', past)).toEqual({ sla_remaining: '已关闭', sla_level: 'closed' })
    expect(deriveSla('closed_no_response', past)).toEqual({ sla_remaining: '已关闭', sla_level: 'closed' })
  })

  it('无截止时间（后端 sla 为 null）→ 无 SLA / closed，不参与倒计时', () => {
    expect(deriveSla('pending', null)).toEqual({ sla_remaining: '无 SLA', sla_level: 'closed' })
    expect(deriveSla('pending', undefined)).toEqual({ sla_remaining: '无 SLA', sla_level: 'closed' })
    expect(deriveSla('pending', { reply_deadline: null, expires_soon: false })).toEqual({
      sla_remaining: '无 SLA',
      sla_level: 'closed',
    })
  })

  it('已过期 → 过期 Nd / overdue', () => {
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
    expect(deriveSla('pending', { reply_deadline: '2026-09-08T00:00:00Z', expires_soon: true })).toEqual({
      sla_remaining: '过期 1d',
      sla_level: 'overdue',
    })
  })

  it('24h 内 → 剩 Nh / soon', () => {
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
    expect(deriveSla('pending', { reply_deadline: '2026-09-09T06:00:00Z', expires_soon: true })).toEqual({
      sla_remaining: '剩 6h',
      sla_level: 'soon',
    })
  })

  it('24h 以上 → 剩 Nd / ok（向上取整天）', () => {
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
    expect(deriveSla('pending', { reply_deadline: '2026-09-10T06:00:00Z', expires_soon: false })).toEqual({
      sla_remaining: '剩 2d',
      sla_level: 'ok',
    })
  })
})

describe('mapComplaintItem', () => {
  it('order_info 快照进列表项 + project_name 优先取后端字段', () => {
    const item = mapComplaintItem(backendItem({ project_name: '犀牛' }))
    expect(item.project_name).toBe('犀牛')
    expect(item.order_id).toBe('112-8707798-7079456')
    expect(item.asin).toBe('B0CR19VKBX')
    expect(item.category_badge).toBe('有订单')
  })

  it('后端缺 project_name 时用 projectNameById 兜底，再退 #id', () => {
    const map = new Map([[18, '犀牛'], [16, '吕沃']])
    expect(mapComplaintItem(backendItem(), map).project_name).toBe('犀牛')
    expect(mapComplaintItem(backendItem({ project_id: 99 }), map).project_name).toBe('#99')
  })

  it('message_date 取 YYYY-MM-DD 前 10 位（后端 date 序列化无时间后缀时也稳）', () => {
    const item = mapComplaintItem(backendItem({ message_date: '2026-09-02' }))
    expect(item.message_date).toBe('2026-09-02')
  })

  it('order_info 缺失（列表项不含该键）→ order_id / asin / product_title 落 null', () => {
    const { order_info: _omit, ...rest } = backendItem()
    const item = mapComplaintItem(rest)
    expect(item.order_id).toBeNull()
    expect(item.asin).toBeNull()
    expect(item.product_title).toBeNull()
  })
})

describe('mapComplaintDetail', () => {
  it('order_info → order，triage / sla / status_history 原样透传', () => {
    const detail = mapComplaintDetail(
      backendItem({
        message_body: 'Need another blanket.',
        triage: { category: 'with_order', has_order: true, summary_zh: '买家称电热毯坏了' },
        sla: { reply_deadline: '2099-01-01T00:00:00Z', expires_soon: false },
        status_history: [
          { from: null, to: 'pending', at: '2026-09-04T10:00:00Z', by: 'agent:complaint_bot' },
        ],
      }),
      new Map([[18, '犀牛']])
    )
    expect(detail.project_name).toBe('犀牛')
    expect(detail.order?.order_id).toBe('112-8707798-7079456')
    expect(detail.triage.summary_zh).toBe('买家称电热毯坏了')
    expect(detail.sla.reply_deadline).toBe('2099-01-01T00:00:00Z')
    expect(detail.status_history).toHaveLength(1)
    expect(detail.status_history[0].by).toBe('agent:complaint_bot')
  })

  it('triage / sla / status_history 缺失时给空值兜底（后端 PATCH 响应历史为空数组）', () => {
    const detail = mapComplaintDetail(
      backendItem({ has_order: false, category: 'no_order_info', order_info: null })
    )
    expect(detail.order).toBeNull()
    expect(detail.triage).toEqual({ category: 'no_order_info', has_order: false, summary_zh: '' })
    expect(detail.sla).toEqual({ reply_deadline: null, expires_soon: false })
    expect(detail.status_history).toEqual([])
  })
})

describe('fetchComplaintList', () => {
  function stubListFetch(): Mock {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, page_size: 20, spam_count: 0 }),
      }))
    )
    return fetch as unknown as Mock
  }

  it('设值时透传 first_message_date 查询参数', async () => {
    const spy = stubListFetch()
    try {
      await fetchComplaintList({ date: '2026-09-04', first_message_date: '2026-09-02' })
      const url = String(spy.mock.calls[0][0])
      expect(url).toContain('first_message_date=2026-09-02')
      expect(url).toContain('date=2026-09-04')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('未设时不发送该参数（空值不进查询串）', async () => {
    const spy = stubListFetch()
    try {
      await fetchComplaintList({ date: '2026-09-04' })
      const url = String(spy.mock.calls[0][0])
      expect(url).not.toContain('first_message_date')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
