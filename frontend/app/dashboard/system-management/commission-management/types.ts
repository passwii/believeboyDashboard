export type PaymentStatus = 'paid' | 'partial' | 'unpaid'
export type SiteCode = 'US' | 'DE' | 'UK'
export const SITE_ORDER: SiteCode[] = ['US', 'DE', 'UK']

export interface CommissionProjectMonth {
  id: number
  report_month: string
  country: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  note: string | null
}

export interface ExchangeRate {
  currency: string
  rate: number
}

export interface ProjectMeta {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

// 扁平化的项目行，包含 Row Span 信息
export interface ProjectRow {
  projectId: number
  projectName: string
  rowSpan: number  // 项目名列需要合并的行数，0 表示不显示项目名
  record: CommissionProjectMonth  // 该行的完整数据
}
