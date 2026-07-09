import { describe, it, expect } from 'vitest'
import { getExcelNumFmt } from './excel-num-fmt'

describe('getExcelNumFmt', () => {
  it('renders the USD dollar symbol by default', () => {
    expect(getExcelNumFmt('currency_usd')).toBe('"$"#,##0.00;[Red]-"$"#,##0.00')
  })

  it('renders the EUR symbol for DE reports', () => {
    expect(getExcelNumFmt('currency_usd', '€')).toBe(
      '"€"#,##0.00;[Red]-"€"#,##0.00',
    )
  })

  it('renders the GBP symbol for UK reports', () => {
    expect(getExcelNumFmt('currency_usd', '£')).toBe(
      '"£"#,##0.00;[Red]-"£"#,##0.00',
    )
  })

  it('keeps the RMB symbol regardless of the currency param', () => {
    expect(getExcelNumFmt('currency_rmb', '€')).toBe('¥#,##0.00;[Red]-¥#,##0.00')
    expect(getExcelNumFmt('currency_rmb_nullable')).toBe(
      '¥#,##0.00;[Red]-¥#,##0.00',
    )
  })

  it('returns percent / rate / integer formats', () => {
    expect(getExcelNumFmt('percent')).toBe('0.0%')
    expect(getExcelNumFmt('rate')).toBe('0.0000')
    expect(getExcelNumFmt('integer')).toBe('#,##0')
  })

  it('returns null for non-numeric formats', () => {
    expect(getExcelNumFmt('text')).toBeNull()
    expect(getExcelNumFmt('boolean')).toBeNull()
  })
})
