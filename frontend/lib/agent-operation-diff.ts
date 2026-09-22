/**
 * Agent 写操作明细语义化（BLF-460 Task 7）。
 *
 * 将 operation_audit_logs 的 before_json / after_json 渲染为人类可读的 diff：
 * 语义化白名单（货件状态等关键字段）+ 通用兜底（顶层键 old → new）。
 *
 * 后端落库形状（agent/shipments.py 等，2026-08 实测）：
 * - shipment.status.transition：before={shipment_status: from}, after={shipment_status: to}
 * - shipment.create：before=null, after={shipment_no, project_id, status, items_count}
 * - shipment.update：before={改动字段的旧值…}, after={shipment_no, project_id, status}
 * - shipment.items.replace：before={items_count}, after={items_count, total_quantity}
 * - 无 Idempotency-Key 的 agent 写调用，after 会附加 {risk: "no_idempotency"} 标记
 */

export type OperationChange = {
  /** 人类可读字段名（已映射，如「货件状态」） */
  field: string
  /** 旧值（null = 无/新增），已格式化（如「在途 (in_transit)」） */
  from: string | null
  /** 新值（null = 无/移除），已格式化 */
  to: string | null
}

export type OperationDescription = {
  /** 操作标题（如「货件状态变更」） */
  title: string
  changes: OperationChange[]
}

// ── 字段名映射（顶层键 → 中文） ─────────────────────────────────────
const FIELD_LABELS: Record<string, string> = {
  status: '货件状态',
  shipment_status: '货件状态',
  shipment_no: '货件编号',
  project_id: '项目 ID',
  items_count: '明细条数',
  total_quantity: '总数量',
  sku: 'SKU',
  shipping_method: '运输方式',
  risk: '风险标记',
  unit_price: '单价',
  quantity: '数量',
  cost: '费用',
  freight: '运费',
  total_cost: '总费用',
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

// ── 值语义化（状态码 / 运输方式 → 中文） ─────────────────────────────
export const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  in_transit: '在途',
  completed: '已入库',
  /** 历史数据别称（早期外部接口用 complete） */
  complete: '已入库',
}

const SHIPPING_METHOD_LABELS: Record<string, string> = {
  sea: '海运',
  air: '空运',
  express: '快递',
  truck: '卡车',
  rail: '铁路',
  other: '其他',
}

function formatValue(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null
  if (key === 'shipment_status' || key === 'status') {
    const code = String(value)
    const label = SHIPMENT_STATUS_LABELS[code]
    return label ? `${label} (${code})` : code
  }
  if (key === 'shipping_method') {
    const code = String(value)
    const label = SHIPPING_METHOD_LABELS[code]
    return label ? `${label} (${code})` : code
  }
  if (key === 'risk') {
    if (value === 'no_idempotency') return '未携带幂等键'
    return String(value)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

import { operationActionLabel } from './agent-operation-labels'

export { operationActionLabel }

const TARGET_TYPE_LABELS: Record<string, string> = {
  shipment_schedule: '货件',
  shop_calculation: '店铺测算',
  new_product_calculation: '新品测算',
  // BLF-845：BLF-579 / BLF-502 / BLF-843 新增写对象的中文标签补齐
  sku_info: 'SKU 主数据',
  inventory_replenishment_setting: '补货设置',
  agent_api_key: 'Agent 凭据',
}

export function targetTypeLabel(targetType: string | null | undefined): string {
  if (!targetType) return '-'
  return TARGET_TYPE_LABELS[targetType] ?? targetType
}

// ── diff 核心 ─────────────────────────────────────────────────────────
type CollectedEntry = { label: string; key: string; value: unknown }

/** 把对象按「中文字段名」归并：status / shipment_status 归并为同一字段。 */
function collectByLabel(record: Record<string, unknown>): Map<string, CollectedEntry> {
  const map = new Map<string, CollectedEntry>()
  for (const [key, value] of Object.entries(record)) {
    const label = fieldLabel(key)
    if (!map.has(label)) map.set(label, { label, key, value })
  }
  return map
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diffChanges(before: unknown, after: unknown): OperationChange[] {
  // 两侧均非对象（纯值 diff，如 recalculate_costs 前的数字快照）→ 单条「值」
  if (!isRecord(before) && !isRecord(after)) {
    if (before === after) return []
    return [
      {
        field: '值',
        from: formatValue(before, ''),
        to: formatValue(after, ''),
      },
    ]
  }

  const beforeMap = collectByLabel(isRecord(before) ? before : {})
  const afterMap = collectByLabel(isRecord(after) ? after : {})
  const labels = [...new Set([...beforeMap.keys(), ...afterMap.keys()])]

  const changes: OperationChange[] = []
  for (const label of labels) {
    const fromEntry = beforeMap.get(label)
    const toEntry = afterMap.get(label)
    const from = fromEntry ? formatValue(fromEntry.value, fromEntry.key) : null
    const to = toEntry ? formatValue(toEntry.value, toEntry.key) : null
    if (from === to) continue
    changes.push({ field: label, from, to })
  }
  return changes
}

/**
 * 把一次写操作的 before/after 渲染为人类可读描述。
 * 语义化白名单（货件状态等）+ 通用兜底（顶层键 old → new）。
 */
export function describeOperation(
  action: string,
  before: unknown,
  after: unknown
): OperationDescription {
  return {
    title: operationActionLabel(action),
    changes: diffChanges(before, after),
  }
}
