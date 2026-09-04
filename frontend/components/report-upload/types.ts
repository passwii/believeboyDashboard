export type ReportType =
  | 'inventory_report'
  | 'inventory_ledger'
  | 'inventory_ledger_summary'
  | 'inventory_ledger_detail'
  | 'business_report'
  | 'ad_product_report'
  | 'ad_search_term_share_report'
  | 'ad_budget_report'
  | 'ad_campaign_report'
  | 'ad_purchased_product_report'
  | 'ad_promoted_product_report'
  | 'ad_invalid_traffic_report'
  | 'ad_placement_report'
  | 'ad_target_report'
  | 'ad_search_term_report'
  | 'ad_time_trend_report'
  | 'sales_report'
  | 'payment_report'
  | 'return_report'

export const AD_REPORT_TYPES: ReadonlyArray<{
  type: Extract<
    ReportType,
    | 'ad_search_term_share_report'
    | 'ad_budget_report'
    | 'ad_campaign_report'
    | 'ad_purchased_product_report'
    | 'ad_promoted_product_report'
    | 'ad_invalid_traffic_report'
    | 'ad_placement_report'
    | 'ad_target_report'
    | 'ad_search_term_report'
    | 'ad_time_trend_report'
  >
  label: string
  short: string
}> = [
  { type: 'ad_search_term_share_report', label: '搜索词展示量份额', short: '词份额' },
  { type: 'ad_budget_report', label: '预算', short: '预算' },
  { type: 'ad_campaign_report', label: '广告活动', short: '广告活动' },
  { type: 'ad_purchased_product_report', label: '已购买商品', short: '已购商品' },
  { type: 'ad_promoted_product_report', label: '推广的商品', short: '推广商品' },
  { type: 'ad_invalid_traffic_report', label: '总流量和无效流量', short: '无效流量' },
  { type: 'ad_placement_report', label: '广告位', short: '广告位' },
  { type: 'ad_target_report', label: '搜索词投放', short: '搜索词投放' },
  { type: 'ad_search_term_report', label: '搜索词', short: '搜索词' },
  { type: 'ad_time_trend_report', label: '按时间查看效果', short: '时间效果' },
] as const

export const REPORT_UPLOAD_COUNTRY_OPTIONS = [
  { value: 'US', label: 'US 美国站' },
  { value: 'DE', label: 'DE 德国站' },
  { value: 'UK', label: 'UK 英国站' },
] as const

export type ReportUploadCountry = (typeof REPORT_UPLOAD_COUNTRY_OPTIONS)[number]['value']

export const DEFAULT_REPORT_UPLOAD_COUNTRY: ReportUploadCountry = 'US'

export function getReportUploadCountryLabel(country: string, short = false): string {
  switch (country) {
    case 'DE':
      return short ? 'DE 站点' : 'DE 德国站'
    case 'UK':
      return short ? 'UK 站点' : 'UK 英国站'
    case 'US':
    default:
      return short ? 'US 站点' : 'US 美国站'
  }
}

export function getMultiCountryDisplay(countries: string[]): string {
  if (!countries || countries.length === 0) return '未识别'
  if (countries.length === 1) {
    return getReportUploadCountryLabel(countries[0], true)
  }
  return countries.map((c) => getReportUploadCountryLabel(c, true)).join(' + ')
}

export type RecognitionStatus = 'recognized' | 'unsupported' | 'error'
export type DateInputMode =
  | 'single_manual'
  | 'single_auto'
  | 'range_manual'
  | 'range_auto'
  | 'multi_auto'
export type ProjectMatchStatus = 'unmatched' | 'matched' | 'conflict' | 'manual'
export type CommitStatus = 'idle' | 'saving' | 'success' | 'error'

export type ProjectMatchSummary = {
  status: ProjectMatchStatus
  project_name: string | null
  candidate_projects: string[]
  matched_by: string | null
  matched_values: string[]
  message: string | null
}

export type RecognitionResponse = {
  temp_file_id: string
  original_filename: string
  extension: string
  report_type: ReportType | 'unknown'
  matched_columns: string[]
  reason: string
  status: RecognitionStatus
  country: string
  /** Multi-country detection for European sales reports */
  detected_countries: string[]
  primary_country: string | null
  date_input_mode: DateInputMode
  detected_date: string | null
  detected_start_date: string | null
  detected_end_date: string | null
  project_match: ProjectMatchSummary
  row_count_preview: number | null
  warnings: string[]
}

export type UploadQueueItem = {
  localId: string
  originalFileName: string
  tempFileId?: string
  reportType: ReportType | 'unknown' | null
  recognitionStatus: 'pending' | RecognitionStatus
  recognizedProject: string | null
  /** 用户手动选择的项目（用于覆盖自动匹配失败的情况） */
  userSelectedProject: string | null
  detectedDate: string | null
  detectedStartDate: string | null
  detectedEndDate: string | null
  /** 单个国家（用于单站点文件） */
  detectedCountry: string | null
  /** 多站点检测（用于欧洲混合文件） */
  detectedCountries: string[]
  isMultiCountry: boolean
  userReportDate: string | null
  userReportStartDate: string | null
  userReportEndDate: string | null
  fileCommitStatus: CommitStatus
  commitError: string | null
  error: string | null
  /** 入库成功后的实际行数（后端 commit 响应 rows_ingested，按行入库类型才有值） */
  rowsIngested: number | null
}

// 需要日期的报表类型
export const DATE_REQUIRED_REPORT_TYPES: ReportType[] = [
  'business_report',
  'inventory_report',
  'inventory_ledger',
  'inventory_ledger_summary',
  'inventory_ledger_detail',
  'ad_product_report',
  'ad_search_term_share_report',
  'ad_budget_report',
  'ad_campaign_report',
  'ad_purchased_product_report',
  'ad_promoted_product_report',
  'ad_invalid_traffic_report',
  'ad_placement_report',
  'ad_target_report',
  'ad_search_term_report',
  'ad_time_trend_report',
  'payment_report',
  'return_report',
]

export function isDateRequired(reportType: ReportType | 'unknown' | null): boolean {
  if (!reportType || reportType === 'unknown') return false
  return DATE_REQUIRED_REPORT_TYPES.includes(reportType as ReportType)
}

export type ReportCardConfig = {
  type: ReportType
  title: string
  subtitle: string
  dateHint: string
  projectHint: string
}

export type ReportCardState = {
  recognition: RecognitionResponse | null
  candidates: RecognitionResponse[]
  activeTempFileId: string | null
  selectedProject: string
  reportDate: string
  reportStartDate: string
  reportEndDate: string
  commitStatus: CommitStatus
  commitMessage: string | null
}
