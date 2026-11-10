/**
 * 意向客户展示辅助函数（纯函数，无 React 依赖）。
 */
import {
  INTENT_STATE_LABELS,
  INTENT_LEVEL_LABELS,
  type IntentLevel,
  type IntentState,
} from './types'

const PRODUCT_SEPARATOR = /[、，,;；/]/

/** 主营产品按顿号/逗号/分号/斜杠切分，去空并与去重；空返回 []。 */
export function splitProducts(products: string | null | undefined): string[] {
  if (!products) return []
  const parts = products
    .split(PRODUCT_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return Array.from(new Set(parts))
}

/** 注册资本（万元）→「300 万」；只接受数值，字符串契约错误由服务端拒绝。 */
export function formatCapitalWan(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${text} 万`
}

/** 0–100 的意向分；空/非法返回 null（渲染为「—」）。 */
export function normalizeScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** ISO/日期字符串 → 本地 YYYY-MM-DD HH:mm；非法返回「—」。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** ISO/日期字符串 → 本地 MM-DD HH:mm；非法返回「—」。 */
export function formatMonthDayTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 日期字符串（YYYY-MM-DD）原样展示，非法返回「—」。 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** ISO → datetime-local input 值（本地时区，精确到分钟）。 */
export function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`
}

/** datetime-local 值 → ISO；空值返回 null。 */
export function fromDateTimeLocalValue(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export type IntentDueInfo = {
  text: string
  overdue: boolean
  daysOverdue: number
}

/** 下次联系口径：next_contact_at <= now 即逾期（不做「当天 23:59」宽限）。 */
export function dueInfo(
  nextContactAt: string | null | undefined,
  now: Date = new Date()
): IntentDueInfo | null {
  if (!nextContactAt) return null
  const date = new Date(nextContactAt)
  if (Number.isNaN(date.getTime())) return null
  if (date.getTime() > now.getTime()) {
    return {
      text: `下次 ${formatMonthDayTime(nextContactAt)}`,
      overdue: false,
      daysOverdue: 0,
    }
  }
  const dayStart = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.max(
    0,
    Math.floor((dayStart(now) - dayStart(date)) / (24 * 60 * 60 * 1000))
  )
  return {
    text: `该联系了 · ${formatMonthDayTime(nextContactAt)}（逾期 ${diff} 天）`,
    overdue: true,
    daysOverdue: diff,
  }
}

/** 只接受 http(s) 来源链接（草稿/设计稿同口径）。 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** 首个有效号优先，否则第一个号码；无号码返回 null。 */
export function bestPhone(phones: Array<{ raw: string; normalized: string; isValid: boolean }>): string | null {
  if (!phones || phones.length === 0) return null
  const valid = phones.find((phone) => phone.isValid)
  const chosen = valid ?? phones[0]
  return chosen.normalized || chosen.raw || null
}

/** 电话号码归一化（前端仅用于展示/共用匹配提示；入库口径以服务端为准）。 */
export function normalizePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  const normalized = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits
  return normalized.length >= 6 ? normalized : null
}

/** 本地当天日期 YYYY-MM-DD（导入批次默认值）。 */
export function todayDateStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

export function levelLabel(level: IntentLevel): string {
  return `${level} · ${INTENT_LEVEL_LABELS[level]}`
}

export function stateLabel(state: IntentState): string {
  return INTENT_STATE_LABELS[state]
}

/** 复制摘要文本（抽屉/卡片共用；只含真实字段，不写营销描述）。 */
export function intentSummaryText(company: {
  name: string
  intentLevel: IntentLevel
  intentScore: number | null
  province: string | null
  city: string | null
  category: string | null
  products: string | null
  intentBasis: string | null
  amazonFit: string | null
  walmartFit: string | null
  risks: string | null
  phones: Array<{ raw: string; normalized: string }>
  followup: { state: IntentState; stateLabel: string; note: string; nextContactAt: string | null }
}): string {
  const lines: string[] = []
  const region = [company.province, company.city].filter(Boolean).join(' · ')
  lines.push(
    `${company.name}（${levelLabel(company.intentLevel)}${company.intentScore !== null ? ` · 意向分 ${company.intentScore}` : ''}）`
  )
  if (region) lines.push(`地区：${region}`)
  if (company.category) lines.push(`类目：${company.category}`)
  if (company.products) lines.push(`主营产品：${company.products}`)
  if (company.intentBasis) lines.push(`意向依据：${company.intentBasis}`)
  if (company.amazonFit) lines.push(`Amazon 适配：${company.amazonFit}`)
  if (company.walmartFit) lines.push(`Walmart 适配：${company.walmartFit}`)
  if (company.risks) lines.push(`疑点：${company.risks}`)
  const phones = company.phones.map((phone) => phone.normalized || phone.raw).filter(Boolean)
  if (phones.length > 0) lines.push(`手机号：${phones.join(' / ')}`)
  lines.push(`跟进：${company.followup.stateLabel}`)
  if (company.followup.note.trim()) lines.push(`备注：${company.followup.note.trim()}`)
  if (company.followup.nextContactAt) {
    lines.push(`下次联系：${formatDateTime(company.followup.nextContactAt)}`)
  }
  return lines.join('\n')
}
