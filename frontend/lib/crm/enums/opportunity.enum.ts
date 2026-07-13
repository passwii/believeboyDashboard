import type { OpportunityStage } from '@/lib/crm/types/opportunity'

export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = {
  lead_in: '线索接入',
  qualified: '需求确认',
  proposal: '方案报价',
  negotiation: '商务谈判',
  won: '已成交',
  lost: '已丢失',
}

export const OPPORTUNITY_STAGE_COLORS: Record<OpportunityStage, string> = {
  lead_in: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-200',
  qualified: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  proposal: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  negotiation: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  won: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  lost: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
}

export const OPPORTUNITY_STAGE_ORDER: OpportunityStage[] = [
  'lead_in',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
]
