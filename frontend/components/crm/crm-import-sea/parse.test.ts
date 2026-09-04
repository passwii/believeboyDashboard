import { describe, expect, it } from 'vitest'
import { parseTsv, rowsFromGrid, validateRows } from './parse'

describe('parseTsv', () => {
  it('按 tab 分列、换行分行，去空行', () => {
    expect(parseTsv('客户名\t等级\n甲公司\tA\n乙公司\tB\n')).toEqual([
      ['客户名', '等级'],
      ['甲公司', 'A'],
      ['乙公司', 'B'],
    ])
  })
})

describe('rowsFromGrid', () => {
  it('按中文表头映射 + 枚举标签转值', () => {
    const { rows, missingName } = rowsFromGrid([
      ['客户名', '状态', '来源', '等级', '对象类型'],
      ['甲公司', '活跃', '转介绍', 'A 级（高价值）', '工厂'],
    ])
    expect(missingName).toBe(false)
    expect(rows[0]).toMatchObject({
      name: '甲公司',
      status: 'active',
      source: 'referral',
      rating: 'A',
      customerType: '工厂',
    })
  })
  it('缺客户名列 → missingName=true', () => {
    expect(rowsFromGrid([['简称'], ['x']]).missingName).toBe(true)
  })
  it('数字列转 number', () => {
    const { rows } = rowsFromGrid([
      ['客户名', '年营收', '员工数'],
      ['甲', '1000', '50'],
    ])
    expect(rows[0].annualRevenue).toBe(1000)
    expect(rows[0].employeeCount).toBe(50)
  })
})

describe('validateRows', () => {
  it('缺名/非法枚举 → error；有电话无联系人 → warn', () => {
    const issues = validateRows([
      { name: '' },
      { name: '坏等级', rating: 'X' },
      { name: '好', contactPhone: '138' },
    ])
    expect(issues).toContainEqual({ row: 1, level: 'error', field: 'name', message: '客户名必填' })
    expect(issues.some((i) => i.row === 2 && i.field === 'rating' && i.level === 'error')).toBe(true)
    expect(issues.some((i) => i.row === 3 && i.level === 'warn')).toBe(true)
  })
})
