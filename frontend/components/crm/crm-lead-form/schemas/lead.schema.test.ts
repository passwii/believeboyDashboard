import { describe, it, expect } from 'vitest'
import { leadSchema } from './lead.schema'

const valid = {
  name: '王五',
  company: '示例公司',
  phone: '13800000000',
  email: 'a@b.com',
  wechat: 'wx123',
  source: 'referral',
  status: 'new',
  intent: 'medium',
  ownerId: 'u-1',
  expectedAmount: 1000,
  expectedCloseDate: '2026-08-01',
  remark: '备注',
}

describe('leadSchema', () => {
  it('合法数据通过', () => {
    expect(leadSchema.safeParse(valid).success).toBe(true)
  })

  it('name 必填', () => {
    const r = leadSchema.safeParse({ ...valid, name: '' })
    expect(r.success).toBe(false)
  })

  it('email 格式校验', () => {
    expect(leadSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
    expect(leadSchema.safeParse({ ...valid, email: '' }).success).toBe(true)
  })

  it('ownerId 允许为 null（未分配），但不可为空字符串', () => {
    expect(leadSchema.safeParse({ ...valid, ownerId: null }).success).toBe(true)
    expect(leadSchema.safeParse({ ...valid, ownerId: '' }).success).toBe(false)
  })

  it('status / intent / source 限定枚举', () => {
    expect(leadSchema.safeParse({ ...valid, status: 'bogus' }).success).toBe(false)
    expect(leadSchema.safeParse({ ...valid, intent: 'bogus' }).success).toBe(false)
    expect(leadSchema.safeParse({ ...valid, source: 'bogus' }).success).toBe(false)
  })
})
