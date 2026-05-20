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

export interface SiteRow {
  country: SiteCode
  hasData: boolean
  record?: CommissionProjectMonth
}

export interface ProjectGroup {
  projectId: number
  projectName: string
  isSingleUS: boolean
  sites: SiteRow[]
}
