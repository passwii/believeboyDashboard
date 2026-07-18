import { describe, it, expect } from 'vitest'
import { opportunitySchema } from './opportunity.schema'

const valid = {
  name: '某项目',
  customerId: 'c-1',
  amount: 50000,
  stage: 'qualified' as const,
  ownerId: 'u-1',
  expectedCloseDate: '2026-09-01',
  probability: 60,
  remark: '备注',
}

describe('opportunitySchema', () => {
  it('合法数据通过', () => {
    expect(opportunitySchema.safeParse(valid).success).toBe(true)
  })

  it('name 必填', () => {
    expect(opportunitySchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('customerId 必填', () => {
    expect(opportunitySchema.safeParse({ ...valid, customerId: '' }).success).toBe(false)
  })

  it('amount 不可为负', () => {
    expect(opportunitySchema.safeParse({ ...valid, amount: -1 }).success).toBe(false)
  })

  it('stage 限定枚举', () => {
    expect(opportunitySchema.safeParse({ ...valid, stage: 'bogus' }).success).toBe(false)
  })

  it('probability 0-100', () => {
    expect(opportunitySchema.safeParse({ ...valid, probability: 150 }).success).toBe(false)
    expect(opportunitySchema.safeParse({ ...valid, probability: 0 }).success).toBe(true)
  })
})
