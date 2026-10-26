import type { Workbook } from 'exceljs'

import { downloadBlob } from '@/lib/download-blob'
import {
  applyDataRowBanding,
  applyDataStyle,
  applyHeaderRowStyle,
  EXCEL_COLORS,
} from '@/lib/excel-styles'

import {
  ALL,
  dispositionLabel,
  eventTypeLabel,
  type IntegrityComparison,
  type LedgerMonthAnalysisResponse,
} from './ledger-types'
import {
  computeMomChange,
  computeOverviewKpis,
  dailyEventSummary,
  dispositionBreakdown,
  formatLedgerMonthLabel,
  groupDetailByEventType,
  skuEndingSummary,
  skuEventTotals,
  topLocations,
  warehouseDispositionSummary,
} from './ledger-derive'

const SIGNED_INT_FORMAT = '#,##0;[Red]-#,##0'
const PCT_FORMAT = '0.0%'

const AUDIT_STATE_LABELS: Record<IntegrityComparison['state'], string> = {
  MATCHED: '一致',
  MISMATCH: '差异',
  CURRENT_ONLY: '本月新增',
  PREVIOUS_ONLY: '上月遗留',
}

type ColumnSpec = {
  header: string
  width: number
  numFmt?: string
}

function resolveIntegrityComparisons(
  integrity: LedgerMonthAnalysisResponse['snapshot']['integrity'],
): IntegrityComparison[] {
  if (!integrity) return []
  if (integrity.comparisons.length > 0) return integrity.comparisons
  return integrity.mismatches.map((item) => ({
    ...item,
    state: item.diff === 0 ? 'MATCHED' : 'MISMATCH',
  }))
}

const SUMMARY_RAW_HEADERS = [
  'Date',
  'FNSKU',
  'ASIN',
  'MSKU',
  'Title',
  'Disposition',
  'Starting Warehouse Balance',
  'In Transit Between Warehouses',
  'Receipts',
  'Customer Shipments',
  'Customer Returns',
  'Vendor Returns',
  'Warehouse Transfer In/Out',
  'Found',
  'Lost',
  'Damaged',
  'Disposed',
  'Other Events',
  'Ending Warehouse Balance',
  'Unknown Events',
  'Location',
  'Store',
  'Record ID',
  'Batch ID',
] as const

const DETAIL_RAW_HEADERS = [
  'Date',
  'FNSKU',
  'ASIN',
  'MSKU',
  'Title',
  'Event Type',
  'Reference ID',
  'Quantity',
  'Fulfillment Center',
  'Disposition',
  'Reason',
  'Country',
  'Reconciled Quantity',
  'Unreconciled Quantity',
  'Date and Time',
  'Store',
  'Record ID',
  'Batch ID',
] as const

function addTableSheet(
  workbook: Workbook,
  name: string,
  columns: ColumnSpec[],
  rows: Array<Array<string | number | null>>,
) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  })
  worksheet.columns = columns.map((column, index) => ({
    header: column.header,
    key: `c${index + 1}`,
    width: column.width,
  }))
  applyHeaderRowStyle(worksheet.getRow(1), columns.length)

  for (const values of rows) worksheet.addRow(values)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const excelRow = worksheet.getRow(rowIndex + 2)
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const cell = excelRow.getCell(columnIndex + 1)
      const column = columns[columnIndex]
      applyDataStyle(cell, {
        align:
          columnIndex === 0
            ? 'left'
            : typeof rows[rowIndex][columnIndex] === 'number'
              ? 'right'
              : 'left',
      })
      if (column.numFmt) cell.numFmt = column.numFmt
    }
  }
  applyDataRowBanding({
    worksheet,
    startRow: 2,
    rowCount: rows.length,
    columnCount: columns.length,
  })
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: columns.length },
  }
  return worksheet
}

function addOverviewSheet(workbook: Workbook, data: LedgerMonthAnalysisResponse) {
  const worksheet = workbook.addWorksheet('分析总览', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  })
  worksheet.columns = [
    { header: '指标', key: 'metric', width: 28 },
    { header: '数值', key: 'value', width: 22 },
    { header: '说明', key: 'note', width: 54 },
  ]
  applyHeaderRowStyle(worksheet.getRow(1), 3)

  const kpis = computeOverviewKpis(data.summary_rows, data.detail_rows)
  const momChange = computeMomChange(data.snapshot.skus, ALL)
  const dispositions = dispositionBreakdown(data.summary_rows)
  const locations = topLocations(data.summary_rows, 5)
  const events = groupDetailByEventType(data.detail_rows)
  const comparisons = resolveIntegrityComparisons(data.snapshot.integrity)
  const unpairedCount = comparisons.filter(
    (item) => item.state === 'CURRENT_ONLY' || item.state === 'PREVIOUS_ONLY',
  ).length
  const rows: Array<[string, string, string | number | null, string]> = [
    ['报表信息', '项目', data.project_name, '当前项目'],
    ['报表信息', '月份', formatLedgerMonthLabel(data.report_month), '完整自然月'],
    [
      '报表信息',
      '数据范围',
      `${data.start_date} ~ ${data.end_date}（全量）`,
      '不受页面维度筛选影响',
    ],
    ['报表信息', '导出时间', data.generated_at, 'ISO 8601'],
    ['核心 KPI', 'SKU 数', kpis.skuCount, '当月有期末库存的 MSKU 数'],
    ['核心 KPI', '期末总库存', kpis.endingTotal, '所有 MSKU × 仓库 × 状态'],
    ['核心 KPI', '可售库存', kpis.sellableQty, 'Disposition = SELLABLE'],
    ['核心 KPI', '损坏库存', kpis.damagedQty, '非 SELLABLE Disposition'],
    ['核心 KPI', '损坏占比', kpis.damagedPct / 100, '损坏库存 / 期末总库存'],
    ['核心 KPI', '事件净变动', kpis.netChange, 'Detail 数量合计'],
    ['核心 KPI', '事件数', kpis.eventCount, 'Detail 事件行数'],
    ['核心 KPI', '环比变动', momChange, '相对上月期末库存'],
    ...dispositions.map(
      (item): [string, string, number, string] => [
        'Disposition 构成',
        dispositionLabel(item.disposition),
        item.qty,
        `${item.pct.toFixed(2)}%`,
      ],
    ),
    ...locations.map(
      (item): [string, string, number, string] => [
        '仓库 Top 5',
        item.location,
        item.qty,
        '期末库存',
      ],
    ),
    ...events.map(
      (item): [string, string, number, string] => [
        '事件构成',
        eventTypeLabel(item.event_type),
        item.count,
        `净数量 ${item.net_qty}`,
      ],
    ),
    [
      '数据质量',
      '跨月完整性',
      data.snapshot.integrity?.status ?? 'PENDING',
      `比对 ${comparisons.length} 项 · 差异 ${data.snapshot.integrity?.mismatch_count ?? 0} 项 · 单边 ${unpairedCount} 项`,
    ],
    [
      '数据质量',
      '双表一致性',
      data.consistency.status,
      `差异 ${data.consistency.mismatch_count} 项`,
    ],
  ]

  const sectionFills = new Set<string>()
  rows.forEach((values, index) => {
    const row = worksheet.getRow(index + 2)
    row.values = values.slice(1)
    for (let column = 1; column <= 3; column += 1) {
      const cell = row.getCell(column)
      applyDataStyle(cell, {
        align: column === 2 && typeof cell.value === 'number' ? 'right' : 'left',
      })
    }
    if (!sectionFills.has(values[0])) {
      sectionFills.add(values[0])
      row.getCell(1).font = {
        name: EXCEL_COLORS.font,
        bold: true,
        color: { argb: EXCEL_COLORS.text },
      }
    }
  })
  applyDataRowBanding({
    worksheet,
    startRow: 2,
    rowCount: rows.length,
    columnCount: 3,
  })
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const section = rows[rowIndex][0]
    if (section === '核心 KPI') {
      worksheet.getRow(rowIndex + 2).getCell(2).numFmt =
        rows[rowIndex][1] === '损坏占比' ? PCT_FORMAT : SIGNED_INT_FORMAT
    }
  }
}

function addQualitySheet(workbook: Workbook, data: LedgerMonthAnalysisResponse) {
  const worksheet = workbook.addWorksheet('数据质量与批次', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  })
  worksheet.columns = [
    { width: 20 },
    { width: 18 },
    { width: 16 },
    { width: 20 },
    { width: 12 },
    { width: 22 },
    { width: 14 },
    { width: 14 },
    { width: 40 },
  ]

  let rowIndex = 1
  const section = (title: string) => {
    const row = worksheet.getRow(rowIndex)
    row.getCell(1).value = title
    row.getCell(1).font = {
      name: EXCEL_COLORS.font,
      bold: true,
      color: { argb: EXCEL_COLORS.text },
    }
    rowIndex += 1
  }
  const header = (values: string[]) => {
    const row = worksheet.getRow(rowIndex)
    row.values = values
    applyHeaderRowStyle(row, values.length)
    rowIndex += 1
  }
  const dataRow = (values: Array<string | number | null>) => {
    const row = worksheet.getRow(rowIndex)
    row.values = values
    for (let column = 1; column <= values.length; column += 1) {
      applyDataStyle(row.getCell(column), {
        align: typeof values[column - 1] === 'number' ? 'right' : 'left',
      })
    }
    rowIndex += 1
  }

  section('Summary / Detail 双表对账')
  header(['报告月份', '状态', '差异数', 'MSKU', '仓库', 'Disposition', 'Detail 合计', 'Summary 变动', '差异'])
  if (data.consistency.mismatches.length === 0) {
    dataRow([data.report_month, data.consistency.status, 0, '', '', '', null, null, null])
  } else {
    for (const item of data.consistency.mismatches) {
      dataRow([
        data.report_month,
        data.consistency.status,
        data.consistency.mismatch_count,
        item.msku,
        item.location,
        item.disposition,
        item.detail_quantity,
        item.summary_delta,
        item.diff,
      ])
    }
  }

  rowIndex += 1
  section('所选月份上传批次')
  header(['文件名', '类型', '状态', '上传时间', '解析行数', '写入汇总', '写入明细', '失败行数', '错误信息'])
  for (const batch of data.batches) {
    dataRow([
      batch.source_filename,
      batch.file_kind,
      batch.status,
      batch.loaded_at,
      batch.rows_parsed,
      batch.rows_written_summary,
      batch.rows_written_detail,
      batch.rows_failed_validation,
      batch.error_message ?? '',
    ])
  }
}

function addAuditSheet(workbook: Workbook, data: LedgerMonthAnalysisResponse) {
  const worksheet = workbook.addWorksheet('盘库', {
    views: [{ showGridLines: false }],
  })
  worksheet.columns = [
    { width: 20 },
    { width: 38 },
    { width: 14 },
    { width: 24 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
  ]

  let rowIndex = 1
  const section = (title: string) => {
    const row = worksheet.getRow(rowIndex)
    row.getCell(1).value = title
    row.getCell(1).font = {
      name: EXCEL_COLORS.font,
      bold: true,
      color: { argb: EXCEL_COLORS.text },
    }
    rowIndex += 1
  }
  const header = (values: string[]) => {
    const row = worksheet.getRow(rowIndex)
    row.values = values
    applyHeaderRowStyle(row, values.length)
    rowIndex += 1
  }
  const dataRow = (
    values: Array<string | number | null>,
    formats: Array<string | undefined> = [],
  ) => {
    const row = worksheet.getRow(rowIndex)
    row.values = values
    for (let column = 1; column <= values.length; column += 1) {
      const cell = row.getCell(column)
      applyDataStyle(cell, {
        align: typeof values[column - 1] === 'number' ? 'right' : 'left',
      })
      const numFmt = formats[column - 1]
      if (numFmt) cell.numFmt = numFmt
    }
    rowIndex += 1
  }

  section('本月期初 vs 上月期末')
  header(['MSKU', '品名', '仓库', 'Disposition', '上月期末', '本月期初', '差异', '结果'])

  const integrity = data.snapshot.integrity
  const comparisons = resolveIntegrityComparisons(integrity)
  const titleByMsku = new Map(
    data.snapshot.skus.map((item) => [item.msku, item.title ?? '']),
  )
  const comparisonStartRow = rowIndex
  if (comparisons.length === 0) {
    dataRow([
      '—',
      '—',
      '—',
      '—',
      null,
      null,
      null,
      integrity?.status === 'PENDING' ? '无可比对数据' : '无可比对记录',
    ])
  } else {
    for (const item of comparisons) {
      dataRow(
        [
          item.msku,
          titleByMsku.get(item.msku) ?? '',
          item.location,
          item.disposition,
          item.prev_ending,
          item.curr_starting,
          item.diff,
          AUDIT_STATE_LABELS[item.state],
        ],
        [
          undefined,
          undefined,
          undefined,
          undefined,
          SIGNED_INT_FORMAT,
          SIGNED_INT_FORMAT,
          SIGNED_INT_FORMAT,
          undefined,
        ],
      )
    }
  }
  applyDataRowBanding({
    worksheet,
    startRow: comparisonStartRow,
    rowCount: Math.max(1, comparisons.length),
    columnCount: 8,
  })

  rowIndex += 1
  section('近 6 个月趋势')
  header([
    '月份',
    'SKU 数',
    '期末库存',
    '期末环比',
    '入库',
    '出库',
    '退货',
    '损坏',
    '盘亏',
    '报废',
    '损坏率',
  ])

  let previousQty: number | null = null
  const trendStartRow = rowIndex
  for (const month of data.trend.months) {
    const change = previousQty === null ? null : month.total_qty_eom - previousQty
    previousQty = month.total_qty_eom
    dataRow(
      [
        month.report_month,
        month.sku_count,
        month.total_qty_eom,
        change,
        month.total_receipts,
        month.total_shipments,
        month.total_returns,
        month.total_damaged,
        month.total_lost,
        month.total_disposed,
        month.damaged_pct / 100,
      ],
      [
        undefined,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        SIGNED_INT_FORMAT,
        PCT_FORMAT,
      ],
    )
  }
  applyDataRowBanding({
    worksheet,
    startRow: trendStartRow,
    rowCount: data.trend.months.length,
    columnCount: 11,
  })
}

function addRawSummarySheet(workbook: Workbook, data: LedgerMonthAnalysisResponse) {
  const rows = data.summary_rows.map((row) => [
    row.date,
    row.fnsku,
    row.asin,
    row.msku,
    row.title,
    row.disposition,
    row.location,
    row.starting_balance,
    row.in_transit_between,
    row.receipts,
    row.customer_shipments,
    row.customer_returns,
    row.vendor_returns,
    row.warehouse_transfer_io,
    row.found,
    row.lost,
    row.damaged,
    row.disposed,
    row.other_events,
    row.ending_balance,
    row.unknown_events,
    row.store,
    row.id,
    row.batch_id,
  ])
  addTableSheet(
    workbook,
    'Summary原始数据',
    SUMMARY_RAW_HEADERS.map((header, index) => ({
      header,
      width: index === 4 ? 36 : index >= 6 && index <= 19 ? 15 : 16,
      numFmt: index >= 6 && index <= 19 ? SIGNED_INT_FORMAT : undefined,
    })),
    rows,
  )
}

function addRawDetailSheet(workbook: Workbook, data: LedgerMonthAnalysisResponse) {
  const rows = data.detail_rows.map((row) => [
    row.date,
    row.fnsku,
    row.asin,
    row.msku,
    row.title,
    row.event_type,
    row.reference_id,
    row.quantity,
    row.fulfillment_center,
    row.disposition,
    row.reason,
    row.country,
    row.reconciled_quantity,
    row.unreconciled_quantity,
    row.date_and_time,
    row.store,
    row.id,
    row.batch_id,
  ])
  addTableSheet(
    workbook,
    'Detail原始数据',
    DETAIL_RAW_HEADERS.map((header, index) => ({
      header,
      width: index === 4 ? 36 : index === 14 ? 24 : 16,
      numFmt:
        index === 7 || index === 12 || index === 13
          ? SIGNED_INT_FORMAT
          : undefined,
    })),
    rows,
  )
}

export async function buildLedgerAnalysisWorkbook(
  data: LedgerMonthAnalysisResponse,
): Promise<Workbook> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'BelieveBoy Dashboard'
  workbook.created = new Date()

  addOverviewSheet(workbook, data)
  addAuditSheet(workbook, data)

  const skuRows = skuEndingSummary(data.summary_rows)
  addTableSheet(
    workbook,
    'SKU期末与环比',
    [
      { header: 'MSKU', width: 20 },
      { header: '品名', width: 38 },
      { header: '期末总库存', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '可售库存', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '损坏库存', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '损坏占比', width: 14, numFmt: PCT_FORMAT },
      { header: '上月期末', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '环比变动', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '环比比例', width: 14, numFmt: PCT_FORMAT },
    ],
    skuRows.map((row) => {
      const snapshotSku = data.snapshot.skus.find((item) => item.msku === row.msku)
      const changePct =
        snapshotSku?.prev_qty_eom && snapshotSku.prev_qty_eom !== 0
          ? (snapshotSku.change ?? 0) / snapshotSku.prev_qty_eom
          : null
      return [
        row.msku,
        row.title,
        row.endingQty,
        row.sellableQty,
        row.damagedQty,
        row.damagedPct / 100,
        snapshotSku?.prev_qty_eom ?? null,
        snapshotSku?.change ?? null,
        changePct,
      ]
    }),
  )

  addTableSheet(
    workbook,
    'SKU事件汇总',
    [
      { header: 'MSKU', width: 20 },
      { header: '品名', width: 38 },
      { header: '入库', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '客户发货', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '客户退货', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '供应商退货', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '仓库调拨', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '盘盈', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '盘亏', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '损坏', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '报废', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '其他', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '净变动', width: 14, numFmt: SIGNED_INT_FORMAT },
    ],
    skuEventTotals(data.summary_rows).map((row) => [
      row.msku,
      row.title,
      row.receipts,
      row.customerShipments,
      row.customerReturns,
      row.vendorReturns,
      row.warehouseTransfer,
      row.found,
      row.lost,
      row.damaged,
      row.disposed,
      row.otherEvents,
      row.netChange,
    ]),
  )

  addTableSheet(
    workbook,
    '仓库状态库存',
    [
      { header: '仓库', width: 14 },
      { header: 'Disposition', width: 24 },
      { header: '期初库存', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '期末库存', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '入库', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '客户发货', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '客户退货', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '供应商退货', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '仓库调拨', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '损坏', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '报废', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '其他', width: 12, numFmt: SIGNED_INT_FORMAT },
    ],
    warehouseDispositionSummary(data.summary_rows).map((row) => [
      row.location,
      row.disposition,
      row.startingBalance,
      row.endingBalance,
      row.receipts,
      row.customerShipments,
      row.customerReturns,
      row.vendorReturns,
      row.warehouseTransfer,
      row.damaged,
      row.disposed,
      row.otherEvents,
    ]),
  )

  addTableSheet(
    workbook,
    '每日事件分析',
    [
      { header: '日期', width: 14 },
      { header: '事件数', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '净数量', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '入库', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '出库', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '客户退货', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '供应商退货', width: 14, numFmt: SIGNED_INT_FORMAT },
      { header: '调拨', width: 12, numFmt: SIGNED_INT_FORMAT },
      { header: '调整', width: 12, numFmt: SIGNED_INT_FORMAT },
    ],
    dailyEventSummary(data.detail_rows).map((row) => [
      row.date,
      row.eventCount,
      row.netQty,
      row.quantities.Receipts ?? 0,
      row.quantities.Shipments ?? 0,
      row.quantities.CustomerReturns ?? 0,
      row.quantities.VendorReturns ?? 0,
      row.quantities.WhseTransfers ?? 0,
      row.quantities.Adjustments ?? 0,
    ]),
  )

  addQualitySheet(workbook, data)
  addRawSummarySheet(workbook, data)
  addRawDetailSheet(workbook, data)
  return workbook
}

function safeFilenamePart(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, '-').trim() || '未命名项目'
}

export async function exportLedgerAnalysisToExcel(
  data: LedgerMonthAnalysisResponse,
): Promise<void> {
  const workbook = await buildLedgerAnalysisWorkbook(data)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  downloadBlob(
    blob,
    `库存分类账分析-${safeFilenamePart(data.project_name)}-${data.report_month.slice(0, 7)}.xlsx`,
  )
}
