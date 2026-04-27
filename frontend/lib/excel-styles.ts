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
  worksheet.views = [{ state: 'frozen', showGridLines: false }]
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
