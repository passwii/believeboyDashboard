import type { CustomerSeaImportRow } from '@/lib/crm/types'
import {
  CRM_IMPORT_COLUMNS,
  CUSTOMER_TYPE_VALUES,
  INTERESTED_SERVICE_VALUES,
  RATING_VALUES,
  SOURCE_LABEL_TO_VALUE,
  SOURCE_VALUES,
  STATUS_LABEL_TO_VALUE,
  STATUS_VALUES,
} from '@/lib/crm/constants/import-columns'
import type { RowIssue } from './types'

/** 解析 Excel 复制出的 TSV：\n 分行、\t 分列，丢弃全空行。 */
export function parseTsv(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((c) => c.trim()))
}

function mapEnum(field: string, raw: string): string | undefined {
  const v = raw.trim()
  if (!v) return undefined
  if (field === 'status') return STATUS_LABEL_TO_VALUE[v] ?? v
  if (field === 'source') return SOURCE_LABEL_TO_VALUE[v] ?? v
  if (field === 'rating') {
    const first = v.slice(0, 1).toUpperCase()
    return RATING_VALUES.has(first) ? first : v
  }
  return v
}

/** 二维网格（首行表头）→ 导入行。按中文表头名匹配，缺列留空，多余列忽略。 */
export function rowsFromGrid(grid: string[][]): { rows: CustomerSeaImportRow[]; missingName: boolean } {
  if (grid.length === 0) return { rows: [], missingName: true }
  const header = grid[0].map((h) => h.trim())
  const colIndex = new Map<string, number>()
  CRM_IMPORT_COLUMNS.forEach((def) => {
    const i = header.indexOf(def.header)
    if (i >= 0) colIndex.set(def.field as string, i)
  })
  const missingName = !colIndex.has('name')
  const rows: CustomerSeaImportRow[] = grid.slice(1).map((cells) => {
    const row: Record<string, unknown> = {}
    CRM_IMPORT_COLUMNS.forEach((def) => {
      const i = colIndex.get(def.field as string)
      if (i === undefined) return
      const raw = (cells[i] ?? '').trim()
      if (!raw) return
      const field = def.field as string
      if (field === 'annualRevenue' || field === 'employeeCount') {
        const n = Number(raw)
        if (Number.isFinite(n)) row[field] = n
      } else if (field === 'status' || field === 'source' || field === 'rating') {
        row[field] = mapEnum(field, raw)
      } else {
        row[field] = raw
      }
    })
    return row as unknown as CustomerSeaImportRow
  })
  return { rows, missingName }
}

/** 逐行校验：error 阻止导入，warn 仅提示。重复由后端判，前端不查。 */
export function validateRows(rows: CustomerSeaImportRow[]): RowIssue[] {
  const issues: RowIssue[] = []
  rows.forEach((row, i) => {
    const rowNo = i + 1
    if (!(row.name ?? '').trim())
      issues.push({ row: rowNo, level: 'error', field: 'name', message: '客户名必填' })
    if (row.rating && !RATING_VALUES.has(row.rating))
      issues.push({ row: rowNo, level: 'error', field: 'rating', message: `等级无效：${row.rating}` })
    if (row.status && !STATUS_VALUES.has(row.status))
      issues.push({ row: rowNo, level: 'error', field: 'status', message: `状态无效：${row.status}` })
    if (row.source && !SOURCE_VALUES.has(row.source))
      issues.push({ row: rowNo, level: 'error', field: 'source', message: `来源无效：${row.source}` })
    if (row.customerType && !CUSTOMER_TYPE_VALUES.has(row.customerType))
      issues.push({
        row: rowNo,
        level: 'error',
        field: 'customerType',
        message: `对象类型无效：${row.customerType}`,
      })
    if (row.interestedService && !INTERESTED_SERVICE_VALUES.has(row.interestedService))
      issues.push({
        row: rowNo,
        level: 'error',
        field: 'interestedService',
        message: `意向服务无效：${row.interestedService}`,
      })
    if (row.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.contactEmail))
      issues.push({ row: rowNo, level: 'error', field: 'contactEmail', message: '邮箱格式不正确' })
    if (
      !(row.contactName ?? '').trim() &&
      ((row.contactPhone ?? '').trim() || (row.contactEmail ?? '').trim())
    )
      issues.push({ row: rowNo, level: 'warn', message: '无联系人姓名，电话/邮箱将不保存' })
  })
  return issues
}
