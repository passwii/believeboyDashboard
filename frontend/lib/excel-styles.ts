import type { Cell, Row, Worksheet } from 'exceljs'

export const EXCEL_COLORS = {
  border: 'FFE2E8F0',
  headerBorder: 'FFCBD5E1',
  text: 'FF0F172A',
  headerFill: 'FFE2E8F0',
  font: 'Microsoft YaHei',
  secondaryText: 'FF475569',
  tertiaryText: 'FF64748B',
  altRowFill: 'FFF8FAFC',
  white: 'FFFFFFFF',
  /** 分组横向分隔线（组边界 medium 粗线 / 组内细线共用此色） */
  groupRule: 'FF94A3B8',
} as const

/**
 * 为单个单元格应用边框
 */
export function applyBorder(cell: Cell, color = EXCEL_COLORS.border as string) {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
}

/**
 * 为单个单元格应用表头边框（颜色更深）
 */
export function applyHeaderBorder(cell: Cell) {
  applyBorder(cell, EXCEL_COLORS.headerBorder)
}

/**
 * 为整行所有单元格应用边框（包含空单元格）
 * 适用于：汇总行、合并单元格行等只有部分列有数据的行
 * @param row Excel Row 对象
 * @param startCol 起始列（从1开始）
 * @param endCol 结束列（从1开始）
 * @param color 边框颜色，默认 EXCEL_COLORS.border
 */
export function applyRowBorder(
  row: Row,
  startCol: number,
  endCol: number,
  color = EXCEL_COLORS.border as string
) {
  for (let col = startCol; col <= endCol; col++) {
    const cell = row.getCell(col)
    applyBorder(cell, color)
  }
}

/**
 * 为行应用表头样式边框（包含空单元格）
 */
export function applyRowHeaderBorder(row: Row, startCol: number, endCol: number) {
  applyRowBorder(row, startCol, endCol, EXCEL_COLORS.headerBorder)
}

/**
 * 为工作表设置无网格线样式
 * 配合 applyRowBorder 使用，可以实现"只为有数据的行添加边框"的效果
 */
export function disableGridLines(worksheet: Worksheet) {
  worksheet.views = [{ showGridLines: false }]
}

export function applyHeaderStyle(cell: Cell) {
  cell.font = {
    name: EXCEL_COLORS.font,
    bold: true,
    color: { argb: EXCEL_COLORS.text },
  }
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: EXCEL_COLORS.headerFill },
  }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
}

export function applyDataStyle(
  cell: Cell,
  options?: { align?: 'left' | 'center' | 'right'; bold?: boolean }
) {
  cell.font = {
    name: EXCEL_COLORS.font,
    bold: options?.bold,
    color: { argb: EXCEL_COLORS.text },
  }
  cell.alignment = { vertical: 'middle', horizontal: options?.align || 'right' }
}

/**
 * 统一表头行样式（对齐 daily-analysis 导出风格）：
 * 微软雅黑加粗 + 浅灰蓝底 + 居中自动换行 + 表头边框。
 * 调用前需先写入表头文本（row.values 或 worksheet.columns）。
 */
export function applyHeaderRowStyle(row: Row, columnCount: number, options?: { height?: number }) {
  row.height = options?.height ?? 22
  for (let col = 1; col <= columnCount; col += 1) {
    const cell = row.getCell(col)
    applyHeaderStyle(cell)
    applyHeaderBorder(cell)
  }
}

export interface TotalRowStyleOptions {
  /** 右对齐的数字列（1-based） */
  numericColumns?: readonly number[]
  /** 居中列（1-based），如日期列 */
  centerColumns?: readonly number[]
}

/**
 * 统一合计行样式：加粗 + 浅灰蓝底 + 顶部分隔粗线（与分组分隔线同色）+ 全行细边框。
 * 数值与 numFmt 由调用方自行写入；空单元格也会被覆盖到，保证整行边框连续。
 */
export function applyTotalRowStyle(
  row: Row,
  columnCount: number,
  options?: TotalRowStyleOptions
) {
  const numericColumns = new Set(options?.numericColumns ?? [])
  const centerColumns = new Set(options?.centerColumns ?? [])
  for (let col = 1; col <= columnCount; col += 1) {
    const cell = row.getCell(col)
    cell.font = {
      name: EXCEL_COLORS.font,
      bold: true,
      color: { argb: EXCEL_COLORS.text },
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: EXCEL_COLORS.altRowFill },
    }
    cell.alignment = {
      vertical: 'middle',
      horizontal: numericColumns.has(col)
        ? 'right'
        : centerColumns.has(col)
          ? 'center'
          : 'left',
    }
    cell.border = {
      top: { style: 'medium', color: { argb: EXCEL_COLORS.groupRule } },
      left: { style: 'thin', color: { argb: EXCEL_COLORS.headerBorder } },
      bottom: { style: 'thin', color: { argb: EXCEL_COLORS.headerBorder } },
      right: { style: 'thin', color: { argb: EXCEL_COLORS.headerBorder } },
    }
  }
}

export interface GroupBandingOptions {
  worksheet: Worksheet
  /** 数据区起始行（1-based，含） */
  startRow: number
  /** 数据行数 */
  rowCount: number
  /** 每行的分组键：相邻相同键的行归为一组 */
  groupKeys: ReadonlyArray<string | number | null | undefined>
  /** 总列数 */
  columnCount: number
  /** 组内多于一行时需要纵向合并的列（1-based），如“项目”“货件编号”关键列 */
  mergeColumn?: number
}

interface RowGroup {
  start: number
  end: number
}

/**
 * 复刻 daily-analysis 明细表的分组带状样式：
 * - 相邻同键行归为一组，组间以白 / 浅灰蓝交替底纹区分；
 * - 横向分隔线在跨多行的组边界加粗；单行组相邻时保持细线，
 *   因此数据未按分组键聚簇时会自动退化为干净的逐行斑马纹；
 * - 首末列纵向加粗形成表格左右外框（横线统一用 groupRule 色、竖线用 headerBorder 色，
 *   与 daily-analysis 明细表的观感一致）；
 * - 可选将分组键列按组纵向合并，锚点单元格加粗居中。
 *
 * 注意：需在数据行写入之后、其他合并操作之前调用（先铺样式后合并）。
 */
export function applyGroupBanding(options: GroupBandingOptions) {
  const { worksheet, startRow, rowCount, groupKeys, columnCount, mergeColumn } = options
  if (rowCount <= 0) return

  const groups: RowGroup[] = []
  for (let index = 0; index < rowCount; ) {
    let end = index
    const key = String(groupKeys[index] ?? '')
    while (end + 1 < rowCount && String(groupKeys[end + 1] ?? '') === key) {
      end += 1
    }
    groups.push({ start: index, end })
    index = end + 1
  }

  groups.forEach((group, groupIndex) => {
    const previous = groups[groupIndex - 1]
    const next = groups[groupIndex + 1]
    const selfMultiRow = group.end > group.start
    // 仅当本组或紧邻组跨多行时才在组边界画粗线，避免碎片化数据出现满屏粗线
    const strongTop = selfMultiRow || (previous ? previous.end > previous.start : false)
    const strongBottom = selfMultiRow || (next ? next.end > next.start : false)

    const fill =
      groupIndex % 2 === 0 ? EXCEL_COLORS.white : EXCEL_COLORS.altRowFill

    for (let offset = group.start; offset <= group.end; offset += 1) {
      const row = worksheet.getRow(startRow + offset)
      for (let col = 1; col <= columnCount; col += 1) {
        const cell = row.getCell(col)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: fill },
        }
        cell.border = {
          top: {
            style: offset === group.start && strongTop ? 'medium' : 'thin',
            color: { argb: EXCEL_COLORS.groupRule },
          },
          bottom: {
            style: offset === group.end && strongBottom ? 'medium' : 'thin',
            color: { argb: EXCEL_COLORS.groupRule },
          },
          left: {
            style: col === 1 ? 'medium' : 'thin',
            color: { argb: EXCEL_COLORS.headerBorder },
          },
          right: {
            style: col === columnCount ? 'medium' : 'thin',
            color: { argb: EXCEL_COLORS.headerBorder },
          },
        }
      }
    }

    if (mergeColumn && selfMultiRow) {
      worksheet.mergeCells(
        startRow + group.start,
        mergeColumn,
        startRow + group.end,
        mergeColumn
      )
      const anchorCell = worksheet.getCell(startRow + group.start, mergeColumn)
      anchorCell.font = {
        name: EXCEL_COLORS.font,
        size: 11,
        bold: true,
        color: { argb: EXCEL_COLORS.text },
      }
      anchorCell.alignment = { vertical: 'middle', horizontal: 'center' }
    }
  })
}
