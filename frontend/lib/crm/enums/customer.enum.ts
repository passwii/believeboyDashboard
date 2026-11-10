import type { CustomerStatus, CustomerSource, CustomerRating } from '@/lib/crm/types/customer'

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: '活跃',
  lost: '已流失',
  signed: '已签约',
  on_hold: '暂缓',
}

export const CUSTOMER_STATUS_COLORS: Record<CustomerStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  lost: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  signed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  on_hold: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
}

export const CUSTOMER_SOURCE_LABELS: Record<CustomerSource, string> = {
  referral: '转介绍',
  exhibition: '展会',
  online_ad: '线上广告',
  cold_call: '陌拜',
  self_developed: '自主开发',
  customer_radar: '客户雷达',
  other: '其他',
}

export const CUSTOMER_RATING_LABELS: Record<CustomerRating, string> = {
  A: 'A 级（高价值）',
  B: 'B 级（中等）',
  C: 'C 级（一般）',
  D: 'D 级（低）',
}

export const CUSTOMER_RATING_COLORS: Record<CustomerRating, string> = {
  A: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  B: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  C: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-200',
  D: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300',
}
