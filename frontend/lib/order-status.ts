/**
 * 亚马逊订单状态 → 中文展示标签 公共映射
 *
 * 覆盖 Amazon Business Reports / Order Reports 暴露的 4 种核心状态。
 * 供前端各模块（订单信息、报表、邮件预览等）统一使用。
 *
 * - Pending   → 处理中
 * - Shipping  → 发货中
 * - Shipped   → 已发货
 * - Cancelled → 已取消（兼容 Canceled 拼写）
 *
 * 其他未识别状态：原样返回（不强制翻译，避免掩盖异常值）。
 */

export type OrderStatusKey = 'Pending' | 'Shipping' | 'Shipped' | 'Cancelled'

/** 原始英文状态 → 中文展示标签 */
export const ORDER_STATUS_LABELS: Record<OrderStatusKey, string> = {
  Pending: '处理中',
  Shipping: '发货中',
  Shipped: '已发货',
  Cancelled: '已取消',
}

/**
 * 将亚马逊订单状态转换为中文标签。
 *
 * - 大小写不敏感
 * - 同时识别 Cancelled / Canceled 两种拼写
 * - 未识别状态原样返回（保留可观测性）
 */
export function getOrderStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  const normalized = status.trim()
  if (!normalized) return '—'
  const key = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase()
  if (key === 'Canceled') {
    return ORDER_STATUS_LABELS.Cancelled
  }
  if (key in ORDER_STATUS_LABELS) {
    return ORDER_STATUS_LABELS[key as OrderStatusKey]
  }
  return normalized
}

/** Select 选项列表，格式为 "中文 (英文)"。可直接用于 <MultiSelect> / <SelectItem>。 */
export const ORDER_STATUS_OPTIONS: { value: OrderStatusKey; label: string }[] = (
  Object.entries(ORDER_STATUS_LABELS) as [OrderStatusKey, string][]
).map(([value, label]) => ({ value, label: `${label} (${value})` }))
