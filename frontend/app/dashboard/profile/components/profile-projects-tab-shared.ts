export interface ProjectItem {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  is_active: boolean
  project_tier: string | null
}

export type ProjectRole = '主运营' | '助理运营' | null

export const COMMISSION_BASIS_LABEL: Record<string, string> = {
  sales_amount: '销售额',
  cash_received: '平台回款',
  profit_margin: '利润率',
}

export const TIER_BADGE_CLASS: Record<string, string> = {
  T1: 'bg-term-neg/10 text-term-neg border-term-neg/30',
  T2: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  T3: 'bg-term-warn/10 text-term-warn border-term-warn/30',
  T4: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300 border-slate-200 dark:border-slate-800',
}

const OPERATOR_SPLIT_RE = /[、,，;\n]+/

export function splitNames(value: string | null): string[] {
  if (!value) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value.split(OPERATOR_SPLIT_RE)) {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function deriveRole(item: ProjectItem, operatorNames: string[]): ProjectRole {
  if (!operatorNames.length) return null
  if (splitNames(item.project_operator).some((n) => operatorNames.includes(n))) {
    return '主运营'
  }
  if (splitNames(item.assistant_operator).some((n) => operatorNames.includes(n))) {
    return '助理运营'
  }
  return null
}

export function formatCommission(basis: string | null, rate: number | null): string {
  if (rate === null) return '—'
  const pct = (rate * 100).toFixed(2)
  const basisLabel = basis ? (COMMISSION_BASIS_LABEL[basis] ?? basis) : null
  return basisLabel ? `${pct}% · ${basisLabel}` : `${pct}%`
}
