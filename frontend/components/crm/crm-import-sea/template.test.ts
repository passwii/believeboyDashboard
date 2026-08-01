import { describe, expect, it } from 'vitest'
import { buildFailureWorkbook, buildTemplateWorkbook } from './template'
import { CRM_IMPORT_COLUMNS } from '@/lib/crm/constants/import-columns'

describe('buildTemplateWorkbook', () => {
  it('首行表头为 16 列中文', async () => {
    const wb = await buildTemplateWorkbook()
    const header = wb.worksheets[0].getRow(1).values as unknown as string[]
    // exceljs row.values 索引 0 为空，表头从索引 1 开始
    CRM_IMPORT_COLUMNS.forEach((def, i) => expect(header[i + 1]).toBe(def.header))
  })
})

describe('buildFailureWorkbook', () => {
  it('含 16 列 + 错因列，按 failed 行号回填', async () => {
    const rows = [{ name: '甲' }, { name: '' }]
    const failed = [{ row: 2, field: 'name', reason: '客户名必填' }]
    const wb = await buildFailureWorkbook(failed, rows)
    const sheet = wb.worksheets[0]
    const header = sheet.getRow(1).values as unknown as string[]
    expect(header[header.length - 1]).toBe('错因')
    // 只有一行失败（第 2 行），数据行在第 2 行
    const dataRow = sheet.getRow(2).values as unknown as string[]
    expect(dataRow[dataRow.length - 1]).toBe('客户名必填')
  })
})
