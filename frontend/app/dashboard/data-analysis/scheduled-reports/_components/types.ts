// ── 定时报告共享类型定义 ──

export type Frequency = 'daily' | 'weekly' | 'monthly'

export type LedgerStatus = 'sent' | 'failed' | 'missing'

export type ResendStage =
  | 'preparing'
  | 'fetching_data'
  | 'generating_summary'
  | 'rendering_html'
  | 'capturing_screenshot'
  | 'sending'
  | 'done'
  | 'failed'

export interface Subscription {
  id: number
  user_id: number
  email: string
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday: number
  dispatch_day: number
  ai_model: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface LedgerItem {
  id: number
  ledger_key: string
  expected_date: string
  expected_at: string
  frequency: Frequency
  subscription_id: number
  email: string
  project_ids: string
  project_names: string[]
  country: string
  status: LedgerStatus
  latest_delivery_log_id: number | null
  error_message: string | null
  sent_at: string | null
  can_resend: boolean
  last_checked_at: string | null
  screenshot_r2_url: string | null
  screenshot_r2_thumb_url: string | null
  ai_summary: string | null
}

export interface LedgerSummary {
  expected: number
  sent: number
  failed: number
  missing: number
  resendable: number
}

export interface AIModelConfig {
  providerConfigured: boolean
  models: string[]
  defaultModel: string
  premiumModels: string[]
  basicModels: string[]
}

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 周一最早允许的小时 */
export const MIN_HOUR_FOR_MONDAY = 16
