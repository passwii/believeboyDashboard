// ── Scheduled Reports / Ledger 共享常量 ──
// 由多个组件（ledger/page.tsx, LedgerDayGroup, LedgerDetailDialog）共用，
// 修改前请同步搜索。

import type { Frequency, LedgerStatus } from './types'

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

export const STATUS_LABELS: Record<LedgerStatus, string> = {
  sent: '成功',
  failed: '失败',
  missing: '缺失',
}

/** 周日为 0，与 Date#getDay() 一致（适用于 ledger 按日分组的星期显示） */
export const WEEKDAY_LABELS_SUN_FIRST = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
