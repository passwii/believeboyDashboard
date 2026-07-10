import type { LeadStatus, LeadIntent } from '@/lib/crm/types/lead'

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
 new: '新线索',
 contacting: '联系中',
 qualified: '已验证',
 converted: '已转化',
 discarded: '已丢弃',
}

export const LEAD_STATUS_COLORS: Record<LeadStatus, string> = {
 new: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
 contacting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
 qualified: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
 converted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
 discarded: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300',
}

export const LEAD_INTENT_LABELS: Record<LeadIntent, string> = {
 high: '高意向',
 medium: '中意向',
 low: '低意向',
}

export const LEAD_INTENT_COLORS: Record<LeadIntent, string> = {
 high: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
 medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
 low: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300',
}