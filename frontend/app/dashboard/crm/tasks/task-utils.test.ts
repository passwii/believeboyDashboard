import { describe, expect, it } from 'vitest'
import { dueDateState, formatDueDate } from './task-utils'

function iso(daysFromToday: number, hour = 10): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

describe('dueDateState', () => {
  it('无截止 → none', () => {
    expect(dueDateState(undefined)).toBe('none')
    expect(dueDateState('')).toBe('none')
    expect(dueDateState('not-a-date')).toBe('none')
  })
  it('过去 → overdue', () => {
    expect(dueDateState(iso(-1))).toBe('overdue')
    expect(dueDateState(iso(-5))).toBe('overdue')
  })
  it('今天 → today', () => {
    expect(dueDateState(iso(0, 0))).toBe('today')
    expect(dueDateState(iso(0, 23))).toBe('today')
  })
  it('未来 → future', () => {
    expect(dueDateState(iso(1))).toBe('future')
  })
})

describe('formatDueDate', () => {
  it('逾期显示天数', () => {
    const s = formatDueDate(iso(-3))
    expect(s).toMatch(/^逾期 \d+ 天$/)
  })
  it('今日前缀', () => {
    expect(formatDueDate(iso(0))).toMatch(/^今天/)
  })
  it('未来仅日期', () => {
    const s = formatDueDate(iso(2))
    expect(s).toMatch(/^\d{1,2}\/\d{1,2}$/)
  })
  it('无截止 → 空串', () => {
    expect(formatDueDate(undefined)).toBe('')
  })
})
