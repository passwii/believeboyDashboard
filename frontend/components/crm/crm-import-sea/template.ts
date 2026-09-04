import { CRM_IMPORT_COLUMNS } from '@/lib/crm/constants/import-columns'
import type { CustomerSeaImportFailItem, CustomerSeaImportRow } from '@/lib/crm/types'

const HEADERS = CRM_IMPORT_COLUMNS.map((c) => c.header)

function triggerDownload(buffer: BufferSource, filename: string): void {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 导入模板：表头 + 灰字提示行 + 2 行示例。 */
export async function buildTemplateWorkbook(): Promise<import('exceljs').Workbook> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('客户导入')
  sheet.addRow(HEADERS)
  const hintRow = sheet.addRow(CRM_IMPORT_COLUMNS.map((c) => c.hint ?? ''))
  hintRow.eachCell((cell) => {
    cell.font = { color: { argb: 'FF9CA3AF' }, italic: true }
  })
  sheet.addRow([
    '示例科技有限公司', '示例', '家居', '工厂', '代运营', 'B', '活跃', '转介绍',
    '张三', '13800000000', 'zhang@example.com', '深圳市南山区', 'https://example.com',
    '5000000', '120', '示例备注',
  ])
  sheet.addRow(['另一家公司', '', '美妆', '贸易商', 'AI运营', 'A', '已签约', '展会', '李四', '13900000000', '', '', '', '', '', ''])
  return wb
}

export async function downloadImportTemplate(): Promise<void> {
  const wb = await buildTemplateWorkbook()
  triggerDownload(await wb.xlsx.writeBuffer(), '客户导入模板.xlsx')
}

/** 失败明细：16 列 + 错因，按 failed 行号（1-based）回填原始行。 */
export async function buildFailureWorkbook(
  failed: CustomerSeaImportFailItem[],
  rows: CustomerSeaImportRow[]
): Promise<import('exceljs').Workbook> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('导入失败明细')
  sheet.addRow([...HEADERS, '错因'])
  failed.forEach((f) => {
    const src = (rows[f.row - 1] ?? {}) as unknown as Record<string, unknown>
    const cells: unknown[] = CRM_IMPORT_COLUMNS.map((c) => src[c.field as string] ?? '')
    cells.push(f.reason)
    sheet.addRow(cells)
  })
  return wb
}

export async function downloadFailureDetail(
  failed: CustomerSeaImportFailItem[],
  rows: CustomerSeaImportRow[]
): Promise<void> {
  const wb = await buildFailureWorkbook(failed, rows)
  triggerDownload(await wb.xlsx.writeBuffer(), '客户导入失败明细.xlsx')
}
