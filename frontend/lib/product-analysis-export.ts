import type { Cell, Worksheet } from 'exceljs'

export type ExportCountryOption = 'US' | 'DE' | 'UK'

export const CURRENCY_CONFIG: Record<ExportCountryOption, { symbol: string; excelFmt: string }> = {
  US: { symbol: '$', excelFmt: '"$"#,##0.00' },
  DE: { symbol: '€', excelFmt: '"€"#,##0.00' },
  UK: { symbol: '£', excelFmt: '"£"#,##0.00' },
}

export const EXPORT_SUMMARY_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量',
      '广告点击量',
      '广告点击率',
      '广告订单量',
      '广告单占比',
      '广告转化率',
      '广告花费',
      '广告销售额',
      'CPC',
      'ACOS',
      'SP占比',
    ],
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB',
      '成本占比',
      '销售头程',
      '头程占比',
      'FBA配送费',
      '配送费占比',
      '平台佣金',
      '佣金占比',
      '总成本',
      '总成本占比',
    ],
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额',
      '实际销售量',
      '实际退款额',
      '实际退款量',
      '平均售价',
      '退款率',
      '利润',
      '利润率',
    ],
  },
] as const

export const EXPORT_SUMMARY_COLUMNS = EXPORT_SUMMARY_COLUMN_GROUPS.flatMap((g) => g.columns)
export const EXPORT_SUMMARY_COLUMN_SET = new Set<string>(EXPORT_SUMMARY_COLUMNS)

export const EXPORT_DETAIL_COLUMN_GROUPS = [
  {
    title: '销售',
    columns: ['总销量', '总销售额', '页面浏览量', '总访客', '总转化'],
  },
  {
    title: '库存',
    columns: ['库存'],
  },
  {
    title: '推广流量',
    columns: [
      '广告展示量',
      '广告点击量',
      '广告点击率',
      '广告订单量',
      '广告单占比',
      '广告转化率',
      '广告花费',
      '广告销售额',
      'CPC',
      'ACOS',
      'SP占比',
    ],
  },
  {
    title: '自然流量',
    columns: ['自然流量', '自然流量占比', '自然单', '自然单转化'],
  },
  {
    title: '费用占比',
    columns: [
      '产品FOB',
      '成本占比',
      '销售头程',
      '头程占比',
      'FBA配送费',
      '配送费占比',
      '平台佣金',
      '佣金占比',
      '总成本',
      '总成本占比',
    ],
  },
  {
    title: '财务结算',
    columns: [
      '实际销售额',
      '实际销售量',
      '实际退款额',
      '实际退款量',
      '平均售价',
      '退款率',
      '利润',
      '利润率',
    ],
  },
] as const

export const EXPORT_DETAIL_COLUMNS = [
  '日期',
  'SKU',
  ...EXPORT_DETAIL_COLUMN_GROUPS.flatMap((g) => g.columns),
]

export const EXPORT_PERCENT_COLUMNS = new Set([
  '总转化',
  '广告点击率',
  '广告单占比',
  '广告转化率',
  'ACOS',
  'SP占比',
  '自然流量占比',
  '自然单转化',
  '成本占比',
  '头程占比',
  '配送费占比',
  '佣金占比',
  '总成本占比',
  '利润率',
  '退款率',
])

export const EXPORT_CURRENCY_COLUMNS = new Set([
  '总销售额',
  '广告花费',
  '广告销售额',
  'CPC',
  '产品FOB',
  '销售头程',
  'FBA配送费',
  '平台佣金',
  '总成本',
  '利润',
  '实际销售额',
  '实际退款额',
  '平均售价',
])

export const EXPORT_INTEGER_COLUMNS = new Set([
  '总销量',
  '页面浏览量',
  '总访客',
  '广告展示量',
  '广告点击量',
  '广告订单量',
  '自然流量',
  '自然单',
  '实际销售量',
  '实际退款量',
])

export const GROUP_COLORS: Record<string, string> = {
  销售: 'FFDCEEFF',
  推广流量: 'FFFFE6D5',
  自然流量: 'FFDDF7EA',
  费用占比: 'FFFCE7C3',
  库存: 'FFF1F5F9',
  财务结算: 'FFEADFEE',
}

export function toExportNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const text = String(value).replace(/,/g, '')
  const num = Number(text)
  return Number.isFinite(num) ? num : 0
}

export function getExportNumberFormat(
  column: string,
  targetCountry: ExportCountryOption = 'US'
): string | null {
  if (EXPORT_PERCENT_COLUMNS.has(column)) return '0.00%'
  if (EXPORT_CURRENCY_COLUMNS.has(column)) return CURRENCY_CONFIG[targetCountry].excelFmt
  if (EXPORT_INTEGER_COLUMNS.has(column)) return '#,##0'
  return null
}

export function getExportCellValue(column: string, value: unknown): string | number {
  if (value === null || value === undefined) return '-'
  const isNumeric =
    typeof value === 'number' ||
    (typeof value === 'string' &&
      value.trim() !== '' &&
      Number.isFinite(Number(value.replace(/,/g, ''))))
  if ((EXPORT_SUMMARY_COLUMN_SET.has(column) || column === '库存') && isNumeric) {
    return toExportNumber(value)
  }
  return String(value)
}

export function applyCellBorder(cell: Cell, color = 'FFE2E8F0') {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
}

export function autosizeWorksheetColumns(worksheet: Worksheet) {
  worksheet.columns?.forEach((column) => {
    let maxLength = 12
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const raw = cell.value
      const text =
        raw === null || raw === undefined
          ? ''
          : typeof raw === 'object' && 'richText' in raw
            ? (raw as { richText: Array<{ text: string }> }).richText
                .map((item) => item.text)
                .join('')
            : String(raw)
      maxLength = Math.max(maxLength, Math.min(text.length + 4, 18))
    })
    column.width = maxLength
  })
}

export function getISOWeek(dateStr: string): string {
  const date = new Date(dateStr)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`
}

export interface ExportPeriod {
  report_start_date: string
  report_end_date: string
  summary: Record<string, unknown>
  details: Record<string, unknown>[]
  is_partial?: boolean
}

export interface ExportProductAnalysisOptions {
  periods: ExportPeriod[]
  projectName: string
  country: ExportCountryOption
  startDate: string
  endDate: string
  /** 前缀名出现在标题 + 文件名；默认「产品核算」 */
  fileNamePrefix?: string
}

/**
 * Generate and trigger download of a product analysis Excel workbook.
 * Used by both the weekly 「产品核算」 tab and the monthly 「月度 SKU 分析」 tab.
 */
export async function exportProductAnalysisToExcel(
  opts: ExportProductAnalysisOptions
): Promise<void> {
  const { periods, projectName, country, startDate, endDate, fileNamePrefix = '产品分析核算' } = opts

  if (periods.length === 0) return

  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'BelieveBoy'
  wb.created = new Date()

  const projectLabel = projectName || '未知项目'

  // ===== Sheet 1: 汇总 =====
  const summarySheet = wb.addWorksheet('汇总', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
  })
  const lastCol = EXPORT_SUMMARY_COLUMNS.length + 2

  summarySheet.mergeCells(1, 1, 1, lastCol)
  summarySheet.getCell(1, 1).value = `${fileNamePrefix} - 汇总`
  summarySheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  summarySheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }

  summarySheet.mergeCells(2, 1, 2, lastCol)
  summarySheet.getCell(2, 1).value =
    `店铺：${projectLabel}    站点：${country}    日期：${startDate} 至 ${endDate}`
  summarySheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  summarySheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }

  const groupRow = summarySheet.getRow(4)
  const headRow = summarySheet.getRow(5)
  summarySheet.mergeCells(4, 1, 5, 1)
  summarySheet.mergeCells(4, 2, 5, 2)
  groupRow.getCell(1).value = '周次'
  groupRow.getCell(2).value = '日期范围'

  let col = 3
  EXPORT_SUMMARY_COLUMN_GROUPS.forEach((group) => {
    const start = col
    group.columns.forEach((column) => {
      headRow.getCell(col).value = column
      col += 1
    })
    summarySheet.mergeCells(4, start, 4, col - 1)
    const gc = groupRow.getCell(start)
    gc.value = group.title
    gc.alignment = { vertical: 'middle', horizontal: 'center' }
    gc.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    gc.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: GROUP_COLORS[group.title] || 'FFE2E8F0' },
    }
    applyCellBorder(gc)
  })
  ;[groupRow, headRow].forEach((row) => {
    row.eachCell((cell) => {
      cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      if (!cell.fill || !('fgColor' in cell.fill)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
      }
      applyCellBorder(cell, 'FFCBD5E1')
    })
  })

  let rowIdx = 6
  periods.forEach((period) => {
    const row = summarySheet.getRow(rowIdx)
    const weekLabel = getISOWeek(period.report_start_date)
    row.getCell(1).value = period.is_partial ? `${weekLabel} *` : weekLabel
    row.getCell(2).value = `${period.report_start_date} 至 ${period.report_end_date}`
    EXPORT_SUMMARY_COLUMNS.forEach((column, idx) => {
      const cell = row.getCell(idx + 3)
      const val = getExportCellValue(column, period.summary[column])
      cell.value = val
      cell.alignment = {
        vertical: 'middle',
        horizontal: typeof val === 'number' ? 'right' : 'left',
      }
      const numFmt = getExportNumberFormat(column, country)
      if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
      applyCellBorder(cell)
      if (period.is_partial) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
      }
    })
    row.getCell(1).font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: period.is_partial ? { argb: 'FFB45309' } : { argb: 'FF0F172A' },
    }
    row.getCell(2).font = { name: 'Microsoft YaHei' }
    applyCellBorder(row.getCell(1))
    applyCellBorder(row.getCell(2))
    if (period.is_partial) {
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
    }
    rowIdx += 1
  })

  // Totals row
  const totalRow = summarySheet.getRow(rowIdx)
  totalRow.getCell(1).value = '合计'
  totalRow.getCell(2).value = `${periods.length} 周期`
  EXPORT_SUMMARY_COLUMNS.forEach((column, idx) => {
    const cell = totalRow.getCell(idx + 3)
    const sum = periods.reduce((acc, p) => acc + toExportNumber(p.summary[column]), 0)
    cell.value = sum
    cell.alignment = { vertical: 'middle', horizontal: 'right' }
    const numFmt = getExportNumberFormat(column, country)
    if (numFmt) cell.numFmt = numFmt
    cell.font = {
      name: 'Microsoft YaHei',
      bold: true,
      color: column === '利润' || column === '利润率' ? { argb: 'FF047857' } : { argb: 'FF0F172A' },
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
    applyCellBorder(cell, 'FFCBD5E1')
  })
  ;[1, 2].forEach((c) => {
    const cell = totalRow.getCell(c)
    cell.font = { name: 'Microsoft YaHei', bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
    applyCellBorder(cell, 'FFCBD5E1')
  })

  // Note row
  const hasPartial = periods.some((p) => p.is_partial)
  if (hasPartial) {
    rowIdx += 1
    summarySheet.mergeCells(rowIdx, 1, rowIdx, lastCol)
    const noteCell = summarySheet.getCell(rowIdx, 1)
    noteCell.value = '* 黄色背景标记：该周期数据不完整，仅供参考'
    noteCell.font = { name: 'Microsoft YaHei', size: 9, italic: true, color: { argb: 'FFB45309' } }
    noteCell.alignment = { vertical: 'middle', horizontal: 'left' }
  }

  summarySheet.columns = [
    { width: 12 },
    { width: 24 },
    ...EXPORT_SUMMARY_COLUMNS.map((c) => ({
      width: EXPORT_PERCENT_COLUMNS.has(c) ? 12 : EXPORT_CURRENCY_COLUMNS.has(c) ? 14 : 12,
    })),
  ]

  // ===== Sheet 2: SKU明细 =====
  const detailSheet = wb.addWorksheet('SKU明细', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
  })
  const dLastCol = EXPORT_DETAIL_COLUMNS.length

  detailSheet.mergeCells(1, 1, 1, dLastCol)
  detailSheet.getCell(1, 1).value = `${fileNamePrefix} - SKU明细`
  detailSheet.getCell(1, 1).font = {
    name: 'Microsoft YaHei',
    size: 16,
    bold: true,
    color: { argb: 'FF0F172A' },
  }
  detailSheet.getCell(1, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }

  detailSheet.mergeCells(2, 1, 2, dLastCol)
  detailSheet.getCell(2, 1).value =
    `店铺：${projectLabel}    站点：${country}    日期：${startDate} 至 ${endDate}`
  detailSheet.getCell(2, 1).font = {
    name: 'Microsoft YaHei',
    size: 10,
    color: { argb: 'FF475569' },
  }
  detailSheet.getCell(2, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  }

  const dGroupRow = detailSheet.getRow(4)
  const dHeadRow = detailSheet.getRow(5)
  detailSheet.mergeCells(4, 1, 5, 1)
  dGroupRow.getCell(1).value = '日期'
  detailSheet.mergeCells(4, 2, 5, 2)
  dGroupRow.getCell(2).value = 'SKU'

  let dCol = 3
  EXPORT_DETAIL_COLUMN_GROUPS.forEach((group) => {
    const start = dCol
    group.columns.forEach((column) => {
      dHeadRow.getCell(dCol).value = column
      dCol += 1
    })
    detailSheet.mergeCells(4, start, 4, dCol - 1)
    const gc = dGroupRow.getCell(start)
    gc.value = group.title
    gc.alignment = { vertical: 'middle', horizontal: 'center' }
    gc.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    gc.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: GROUP_COLORS[group.title] || 'FFE2E8F0' },
    }
    applyCellBorder(gc)
  })
  ;[dGroupRow, dHeadRow].forEach((row) => {
    row.eachCell((cell) => {
      cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      if (!cell.fill || !('fgColor' in cell.fill)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
      }
      applyCellBorder(cell, 'FFCBD5E1')
    })
  })

  let dRowIdx = 6
  let currentPeriodLabel = ''
  periods.forEach((period) => {
    const periodLabel = `${period.report_start_date} ~ ${period.report_end_date}`
    // Period separator row
    if (periodLabel !== currentPeriodLabel && periods.length > 1) {
      const sepRow = detailSheet.getRow(dRowIdx)
      detailSheet.mergeCells(dRowIdx, 1, dRowIdx, dLastCol)
      sepRow.getCell(1).value = `周期: ${periodLabel}${period.is_partial ? ' (数据不完整)' : ''}`
      sepRow.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F766E' } }
      sepRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
      sepRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' }
      dRowIdx += 1
      currentPeriodLabel = periodLabel
    }

    period.details.forEach((detail) => {
      const row = detailSheet.getRow(dRowIdx)
      EXPORT_DETAIL_COLUMNS.forEach((column, idx) => {
        const cell = row.getCell(idx + 1)
        let val: string | number = ''
        if (column === '日期') {
          val = period.report_end_date
        } else if (column === 'SKU') {
          val = String(detail['SKU'] ?? '')
        } else {
          val = getExportCellValue(column, detail[column])
        }
        ;(cell.value as string | number) = val
        cell.alignment = {
          vertical: 'middle',
          horizontal:
            column === '日期' || column === 'SKU' || typeof val !== 'number' ? 'left' : 'right',
        }
        const numFmt = getExportNumberFormat(column, country)
        if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
        applyCellBorder(cell)
      })
      dRowIdx += 1
    })

    // Period summary row
    const summaryExcelRow = detailSheet.getRow(dRowIdx)
    EXPORT_DETAIL_COLUMNS.forEach((column, idx) => {
      const cell = summaryExcelRow.getCell(idx + 1)
      if (column === '日期') cell.value = period.report_end_date
      else if (column === 'SKU') cell.value = '汇总'
      else {
        const val = getExportCellValue(column, period.summary[column])
        cell.value = val
        const numFmt = getExportNumberFormat(column, country)
        if (typeof val === 'number' && numFmt) cell.numFmt = numFmt
      }
      cell.font = { name: 'Microsoft YaHei', bold: true }
      cell.alignment = {
        vertical: 'middle',
        horizontal: typeof cell.value === 'number' ? 'right' : 'left',
      }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }
      applyCellBorder(cell)
    })
    dRowIdx += 1

    // Blank spacer
    dRowIdx += 1
  })

  detailSheet.columns = EXPORT_DETAIL_COLUMNS.map((col) => ({
    width:
      col === '日期'
        ? 14
        : col === 'SKU'
          ? 22
          : EXPORT_PERCENT_COLUMNS.has(col)
            ? 12
            : EXPORT_CURRENCY_COLUMNS.has(col)
              ? 14
              : 12,
  }))
  autosizeWorksheetColumns(detailSheet)

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileNamePrefix}-${projectName}-${country}-${startDate}~${endDate}.xlsx`
  link.click()
  URL.revokeObjectURL(url)
}
