import { describe, expect, it } from 'vitest'

import { SOURCE_LABEL_TO_VALUE, SOURCE_VALUES } from './import-columns'

describe('公海导入来源白名单（P1-3）', () => {
  it('「客户雷达」标签映射到 customer_radar', () => {
    expect(SOURCE_LABEL_TO_VALUE['客户雷达']).toBe('customer_radar')
  })

  it('SOURCE_VALUES 接受 customer_radar', () => {
    expect(SOURCE_VALUES.has('customer_radar')).toBe(true)
  })
})