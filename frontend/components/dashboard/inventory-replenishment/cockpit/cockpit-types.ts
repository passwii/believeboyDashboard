/**
 * 三段式决策驾驶舱（Decision Cockpit）共享类型与元数据。
 *
 * BLF-491：补货分析前端重构 —— 让「状态/行动/信号」成为组织主轴。
 * 类型与 inventory-replenishment-client.tsx 的 AnalysisRow 结构兼容
 * （结构类型，client 的 row 可直接传入）。
 */

export type CockpitSignals = {
  sellable_days?: number | null
  dms_3?: number | null
  dms_7?: number | null
  dms_14?: number | null
  dms_30?: number | null
  trend_ratio_7_30?: number | null
  trend_ratio_3_7?: number | null
  trend_label?: string | null
  trend_momentum?: string | null
  aging_share?: Record<string, number>
  transit_ratio?: number | null
  data_freshness_days?: number
  confidence?: string
  seasonal_factor?: number | null
  seasonal_phase?: string | null
  seasonal_source?: string | null
}

export type CockpitRow = {
  project_id: number
  project_name: string
  sku: string
  country: string
  asin: string | null
  product_name: string | null
  available_inventory: number
  in_transit_quantity: number
  dms_30: number | null
  dms_14: number | null
  dms_7: number | null
  dms_3: number | null
  base_dms: number | null
  safety_factor: number
  weighted_dms: number | null
  sellable_days: number | null
  sellout_date: string | null
  sellout_date_with_transit: string | null
  production_lead_days: number
  shipping_days: number
  replenishment_order_date: string | null
  warehouse_entry_date: string | null
  shipment_order_date: string | null
  estimated_replenishment_quantity: number | null
  risk_status: string
  risk_anchor_date: string | null
  inventory_state?: string
  replenishment_action?: string
  signals?: CockpitSignals | null
  /** BLF-502：决策路径解释（为什么是这个 state/action） */
  decision_path?: CockpitDecisionPath | null
}

/** BLF-502 S3/G1：后端 InventoryDecisionPath 的决策路径解释。 */
export type CockpitDecisionPath = {
  state_rule?: string | null
  critical_subtype?: string | null
  action_rule?: string | null
  seasonal_override?: boolean
  seasonal_phase_used?: string | null
}

export type CockpitSummary = {
  sku_count: number
  total_available_inventory: number
  total_in_transit_quantity: number
  critical_count?: number
  deteriorating_count?: number
  watch_count?: number
  healthy_count_v2?: number
  unknown_count?: number
}

/** 行动枚举（与后端 ReplenishmentAction 对应） */
export const ACTION_ORDER = [
  'REPLENISH_NOW',
  'REPLENISH_NORMAL',
  'HOLD',
  'REDUCE_PRICE',
  'REMOVE',
  'NO_ACTION',
] as const

export type CockpitAction = (typeof ACTION_ORDER)[number]

export const ACTION_LABELS: Record<string, string> = {
  REPLENISH_NOW: '紧急补货',
  REPLENISH_NORMAL: '按计划补货',
  HOLD: '暂停补货',
  REDUCE_PRICE: '降价清货',
  REMOVE: '移除订单',
  NO_ACTION: '不动',
}

/** 行动 → 中文说明（工作台 lane 副标题用） */
export const ACTION_HINTS: Record<string, string> = {
  REPLENISH_NOW: '可售天数 < 14，存在断货风险，需立即下单',
  REPLENISH_NORMAL: '按当前节奏执行常规补货计划',
  HOLD: '暂停补货、观察趋势（可能是淡季或趋势转差）',
  REDUCE_PRICE: '销量走弱/库龄偏老，建议降价清货',
  REMOVE: '库龄 365+ 死货，建议创建移除订单',
  NO_ACTION: '当前无需操作，保持现有节奏',
}

export const STATE_ORDER = ['critical', 'deteriorating', 'watch', 'healthy', 'unknown'] as const

export const STATE_LABELS: Record<string, string> = {
  critical: '危险',
  deteriorating: '趋势转差',
  watch: '关注',
  healthy: '健康',
  unknown: '数据缺失',
}

/** 状态 → rail / 强调色（亮暗双主题通用，CSS hsl 变量体系内） */
export const STATE_THEME: Record<
  string,
  { rail: string; text: string; softBg: string; dot: string }
> = {
  critical: {
    rail: 'bg-rose-500',
    text: 'text-rose-700 dark:text-rose-300',
    softBg: 'bg-rose-100/70 dark:bg-rose-950/40',
    dot: 'bg-rose-500',
  },
  deteriorating: {
    rail: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
    softBg: 'bg-orange-100/70 dark:bg-orange-950/40',
    dot: 'bg-orange-500',
  },
  watch: {
    rail: 'bg-amber-400',
    text: 'text-amber-700 dark:text-amber-300',
    softBg: 'bg-amber-100/70 dark:bg-amber-950/40',
    dot: 'bg-amber-400',
  },
  healthy: {
    rail: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    softBg: 'bg-emerald-100/70 dark:bg-emerald-950/40',
    dot: 'bg-emerald-500',
  },
  unknown: {
    rail: 'bg-slate-400',
    text: 'text-slate-600 dark:text-slate-300',
    softBg: 'bg-slate-100/70 dark:bg-slate-900/40',
    dot: 'bg-slate-400',
  },
}

/** 行动 → 徽章色 */
export const ACTION_THEME: Record<
  string,
  { badge: string; bar: string; text: string }
> = {
  REPLENISH_NOW: {
    badge:
      'border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300',
    bar: 'bg-rose-500',
    text: 'text-rose-700 dark:text-rose-300',
  },
  REPLENISH_NORMAL: {
    badge:
      'border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
    bar: 'bg-sky-500',
    text: 'text-sky-700 dark:text-sky-300',
  },
  HOLD: {
    badge:
      'border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
    bar: 'bg-amber-400',
    text: 'text-amber-700 dark:text-amber-300',
  },
  REDUCE_PRICE: {
    badge:
      'border-orange-300 bg-orange-100 text-orange-700 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-300',
    bar: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
  REMOVE: {
    badge:
      'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300',
    bar: 'bg-fuchsia-500',
    text: 'text-fuchsia-700 dark:text-fuchsia-300',
  },
  NO_ACTION: {
    badge:
      'border-term-border bg-term-raised text-term-muted dark:border-term-border dark:bg-term-raised dark:text-term-text/72',
    bar: 'bg-slate-400',
    text: 'text-term-muted',
  },
}

/** 季节性 phase → 徽章文案 */
export const SEASONAL_LABELS: Record<string, string> = {
  peak: '旺季',
  rising: '向旺季',
  neutral: '常态',
  falling: '向淡季',
  trough: '淡季',
  unknown: '未知',
}

export const SEASONAL_EMOJI: Record<string, string> = {
  peak: '🔥',
  rising: '↗',
  neutral: '→',
  falling: '↘',
  trough: '❄️',
  unknown: '?',
}

/** 置信度 → 文案 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/** 趋势 momentum → 文案 */
export const MOMENTUM_LABELS: Record<string, string> = {
  accelerating: '加速走弱',
  decelerating: '趋缓回稳',
  stable: '平稳',
}

/** 状态判定规则（state_rule，P0-P13）→ 中文说明（BLF-502 decision_path） */
export const STATE_RULE_LABELS: Record<string, string> = {
  P0: 'DMS 数据缺失，无法判定',
  P1: '调整后可售天数 < 14，立即断货风险',
  P2: '调整后可售天数 14-30 且在售，断货风险',
  P3: '存在库龄 365+ 的库存',
  P4: '库龄 271-365 占 ≥50%',
  P5: '库龄 181-270 占 ≥50%',
  P6: '调整后可售天数 > 180 且慢销（积压）',
  P7: '调整后可售天数 120-180 且慢销',
  P8: '趋势下降明显 + 库龄 91+ ≥30% 或在途/可售 >3',
  P9: '调整后可售天数 45-90 + 趋势下降明显',
  P10: '调整后可售天数 30-45 + 趋势下降明显',
  P11: '调整后可售天数 90-180',
  P12: '其余情况 → 健康',
}

/** critical_subtype → 中文说明 */
export const CRITICAL_SUBTYPE_LABELS: Record<string, string> = {
  shortage: '断货风险',
  aging: '库龄老化',
  overstock: '积压滞销',
}

/** 行动判定分支（action_rule）→ 中文说明（BLF-502 decision_path） */
export const ACTION_RULE_LABELS: Record<string, string> = {
  'shortage-urgent': '调整后可售天数 < 14，需立即补货',
  'shortage-normal-up': '趋势上升，按计划补货',
  'shortage-normal-peak': '旺季覆盖 → 按计划补货',
  'shortage-hold-down': '趋势下降且非旺季，暂停补货',
  'aging-remove': '库龄老化，创建移除订单',
  'overstock-reduce-decline': '趋势下降，降价清货',
  'overstock-reduce-transit': '在途占比过高，降价清货',
  'overstock-hold-trough': '淡季覆盖 → 暂停补货（季节性存量）',
  'overstock-hold-stable': '存量偏高，暂停补货',
  'deteriorating-hold-trough': '淡季覆盖 → 暂停补货',
  'deteriorating-reduce': '趋势转差，降价清货',
  'deteriorating-hold-stable': '趋势回升，暂停补货',
  'no-action': '无需操作，保持现状',
}
