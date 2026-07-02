// ── Scheduled Reports / Ledger 共享常量 ──
// 由多个组件（ledger/page.tsx, LedgerDayGroup, LedgerDetailDialog）共用，
// 修改前请同步搜索。

import type { Frequency, LedgerStatus } from './types'

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

export const FREQUENCY_COLORS: Record<Frequency, string> = {
  daily: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  weekly: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  monthly: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
}

export const STATUS_LABELS: Record<LedgerStatus, string> = {
  sent: '成功',
  failed: '失败',
  missing: '缺失',
}

export const STATUS_BG: Record<LedgerStatus, string> = {
  sent: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  failed: 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  missing: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
}

/** 周日为 0，与 Date#getDay() 一致（适用于 ledger 按日分组的星期显示） */
export const WEEKDAY_LABELS_SUN_FIRST = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
