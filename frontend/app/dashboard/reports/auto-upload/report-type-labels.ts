import {
  AD_REPORT_TYPES,
  type UploadQueueItem,
} from '@/components/report-upload/types'

/** 上传队列 / 识别结果类型的中文标签（历史队列旧值也保留映射，不显示原始 key）。 */
export const REPORT_UPLOAD_REPORT_TYPE_LABELS: Record<string, string> = {
  inventory_report: '亚马逊物流库存',
  business_report: '业务报告',
  ad_product_report: '广告 - 已推广商品',
  sales_report: '销售报表 - 所有订单',
  payment_report: '付款报告',
  return_report: '退货报告',
  // 历史队列可能携带旧值；保留非空映射避免显示原始 key，但不再作为新上传选项
  inventory_ledger: '历史库存分类账类型（待重新识别）',
  inventory_ledger_summary: '库存分类账 · 汇总视图（Summary）',
  inventory_ledger_detail: '库存分类账 · 明细视图（Detail）',
  ...AD_REPORT_TYPES.reduce<Record<string, string>>((acc, item) => {
    acc[item.type] = `广告 - ${item.label}`
    return acc
  }, {}),
}

/** 队列展示用标签；未识别回退「未识别」，未知类型回退原始 key。 */
export function getUploadReportTypeLabel(type: UploadQueueItem['reportType']): string {
  if (!type || type === 'unknown') return '未识别'
  return REPORT_UPLOAD_REPORT_TYPE_LABELS[type] ?? type
}

/** RPA 状态矩阵列定义（key 与后端 status 的 report_type 对齐）。
 * 注意：库存分类账（inventory_ledger_summary / inventory_ledger_detail）不在此页面展示（BLF-482）。
 * 仅保留已激活报表类型；预留/未激活类型已删除（BLF-647）。 */
export const REPORT_TYPES: Array<{ key: string; label: string }> = [
  { key: 'inventory_report', label: '库存' },
  { key: 'business_report', label: '业务' },
  { key: 'sales_report', label: '销售' },
  { key: 'payment_report', label: '付款' },
  { key: 'return_report', label: '退货' },
  // 广告相关列统一加「广告-」前缀（BLF-482），与销售列区分
  ...AD_REPORT_TYPES.map((item) => ({
    key: item.type,
    label: `广告-${item.short}`,
  })),
]
