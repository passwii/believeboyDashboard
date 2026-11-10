import { describe, expect, it } from 'vitest'

import { customerSchema } from './customer.schema'

const convertedCustomer = {
  name: '宁波岚川家居用品有限公司',
  rating: 'A' as const,
  status: 'active' as const,
  source: 'customer_radar' as const,
  ownerId: 'u-1',
}

describe('客户编辑表单来源白名单（P1-3）', () => {
  it('转为客户写入的 customer_radar（客户雷达）可通过编辑校验', () => {
    const result = customerSchema.safeParse(convertedCustomer)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.source).toBe('customer_radar')
  })

  it('未知来源仍被拒绝', () => {
    const result = customerSchema.safeParse({ ...convertedCustomer, source: 'unknown_source' })
    expect(result.success).toBe(false)
  })
})