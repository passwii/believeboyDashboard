// ── 定时报告共享类型定义 ──

export type Frequency = 'daily' | 'weekly' | 'monthly'

export type LedgerStatus = 'sent' | 'failed' | 'missing'

export type AiSummaryStatus = 'pending' | 'generating' | 'done' | 'failed'

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
  /**
   * 旧 integer 归属列（Alembic 123 起），从未匹配上 `user_accounts.id` 的 UUID；
   * 后端为兼容旧契约保留在响应里，新写入一律为 null。归属以 `user_account_id` 为准。
   */
  user_id: number | null
  /** 权威归属账号（`user_accounts.id`，UUID）。BLF-1556 后端修复后新增此字段。 */
  user_account_id?: string | null
  email: string | null
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday: number | null
  dispatch_day: number | null
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
  email: string | null
  project_ids: string
  project_names: string[]
  country: string
  status: LedgerStatus
  latest_delivery_log_id: number | null
  error_message: string | null
  sent_at: string | null
  /** 最新 delivery log 是否真正投递了邮件；false 表示只生成报告（无邮箱或手动重新生成）。 */
  email_sent: boolean
  /** 仅表示该状态可重发（missing/failed）；不代表调用者有管理员权限。 */
  can_resend: boolean
  last_checked_at: string | null
  screenshot_r2_url: string | null
  screenshot_r2_thumb_url: string | null
  ai_summary: string | null
  ai_summary_status: AiSummaryStatus
  ai_summary_error: string | null
  ai_summary_model: string | null
  ai_summary_updated_at: string | null
  /**
   * 后端 Insight run 绑定（BLF-1014）。后端回填前为 null，此时详情面板
   * 退回展示已落库的 `ai_summary`，不自行构造 run。
   */
  insight_run_id?: string | null
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
