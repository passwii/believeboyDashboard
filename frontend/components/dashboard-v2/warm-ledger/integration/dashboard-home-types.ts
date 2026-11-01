export interface DashboardHomeDateRange {
  from: Date
  to: Date
}

export interface DashboardDailyAnalysisRow {
  date: string
  order_qty: number
  pending_order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  ordered_sales_amount: number
  conversion_rate: number
}

export interface DashboardProjectBreakdownEntry {
  project_name: string
  summary_rows: DashboardDailyAnalysisRow[]
}

export interface DashboardCountryBreakdownEntry {
  summary_rows: DashboardDailyAnalysisRow[]
}

export interface DashboardDailyAnalysisResponse {
  summary_rows?: DashboardDailyAnalysisRow[]
  project_breakdown?: Record<number, DashboardProjectBreakdownEntry>
}

export interface DashboardCountriesResponse {
  summary_rows?: DashboardDailyAnalysisRow[]
  country_breakdown?: Record<string, DashboardCountryBreakdownEntry>
  currency_note?: string | null
}
