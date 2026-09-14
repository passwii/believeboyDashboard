/**
 * 退货分析「原始数据」列配置 —— Tab 表格与 Excel sheet 的唯一来源（可单测）。
 *
 * 顺序 = 亚马逊退货报表列顺序：每个原值列后紧跟它的中文翻译列（spec §1.2）。
 * 17 个 key 与后端 `ReturnRawRowItem` 字段一一对应，改名必须两边同改。
 *
 * 中文翻译列由后端用 `app/constants/return_translations.py` 产出，前端不重复翻译，
 * 保证与「退货原因 / 商品状态 / 库存状态」等分析 Tab 的译文永远一致。
 */

export type ReturnRawRow = {
  return_date: string
  original_return_datetime: string
  order_id: string
  sku: string
  asin: string | null
  fnsku: string | null
  product_name: string | null
  quantity: number
  fulfillment_center_id: string | null
  detailed_disposition: string
  disposition_display: string
  reason: string
  reason_display: string
  status: string
  status_display: string
  license_plate_number: string | null
  customer_comment: string | null
}

export type ReturnRawColumn = {
  /** ReturnRawRow 上的字段名（也是取值 key） */
  key: keyof ReturnRawRow
  /** Excel 表头与页面表头共用的中文列名 */
  label: string
  /** Excel 列宽（字符数） */
  width: number
  /** 页面表格该列的最小宽度（Tailwind 任意值类） */
  minWidth: string
  /** true → 单元格单行截断 + title 全量提示 */
  truncate?: boolean
}

export const RETURN_RAW_COLUMNS: ReturnRawColumn[] = [
  { key: 'return_date', label: '退货日期（站点时区）', width: 18, minWidth: 'min-w-[130px]' },
  { key: 'original_return_datetime', label: '原始退货时间', width: 26, minWidth: 'min-w-[190px]' },
  { key: 'order_id', label: '订单号', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'sku', label: 'SKU', width: 20, minWidth: 'min-w-[140px]' },
  { key: 'asin', label: 'ASIN', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'fnsku', label: 'FNSKU', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'product_name', label: '产品名称', width: 46, minWidth: 'min-w-[240px]', truncate: true },
  { key: 'quantity', label: '数量', width: 8, minWidth: 'min-w-[70px]' },
  { key: 'fulfillment_center_id', label: '运营中心', width: 12, minWidth: 'min-w-[96px]' },
  { key: 'detailed_disposition', label: '商品状态', width: 18, minWidth: 'min-w-[130px]' },
  { key: 'disposition_display', label: '商品状态（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'reason', label: '退货原因', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'reason_display', label: '退货原因（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'status', label: '库存属性', width: 22, minWidth: 'min-w-[150px]' },
  { key: 'status_display', label: '库存属性（中文）', width: 14, minWidth: 'min-w-[110px]' },
  { key: 'license_plate_number', label: 'LPN', width: 20, minWidth: 'min-w-[140px]', truncate: true },
  { key: 'customer_comment', label: '顾客评论', width: 60, minWidth: 'min-w-[260px]', truncate: true },
]

/**
 * 页内一次渲染的行数上限（完整数据由导出 Excel 承载）。
 * 真实数据量为单周期数十至数百行；调大此值即放宽页内展示，Excel 不受影响。
 */
export const RAW_DISPLAY_LIMIT = 200
