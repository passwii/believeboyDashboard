import { describe, it, expect } from 'vitest'
import { renderState, type TemplateContext } from '../persona-templates'

const ctx = (overrides: Partial<TemplateContext> = {}): TemplateContext => ({
  bucket: {
    id: 'A-payment',
    projectName: '润茗',
    reportType: 'payment_report',
    reportLabel: 'Payment Report',
    status: 'SUCCEEDED',
    eventCount: 1,
    rowCountTotal: 100,
    firstOccurredAt: new Date('2026-06-10T10:00:00Z'),
    lastOccurredAt: new Date('2026-06-10T10:00:05Z'),
    dateRange: '06-05',
  },
  employeeName: 'Payment Report 数字员工',
  ...overrides,
})

describe('renderState', () => {
  it('WORKING 状态文案', () => {
    const result = renderState('WORKING', ctx())
    expect(result).toContain('润茗')
    expect(result).toContain('Payment Report')
  })

  it('IDLE 状态文案', () => {
    const result = renderState('IDLE', ctx())
    expect(result).toContain('没有新报表')
  })

  it('OFFLINE 状态文案', () => {
    const result = renderState('OFFLINE', ctx())
    expect(result).toContain('工作')
  })

  it('FAILED 桶：WORKING 文案加警告前缀且含"失败"', () => {
    const result = renderState('WORKING', ctx({
      bucket: { ...ctx().bucket!, status: 'FAILED' },
    }))
    expect(result).toContain('⚠️')
    expect(result).toContain('失败')
  })

  it('占位符全部替换无残留 {{...}}', () => {
    for (const state of ['WORKING', 'IDLE', 'OFFLINE'] as const) {
      const result = renderState(state, ctx())
      expect(result).not.toMatch(/\{\{/)
    }
  })

  it('WORKING 但 bucket 为 null 时回退到 IDLE 文案', () => {
    const result = renderState('WORKING', ctx({ bucket: null }))
    expect(result).toContain('没有新报表')
  })
})
