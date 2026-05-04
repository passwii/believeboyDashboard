export type ReportType =
  | 'inventory_report'
  | 'business_report'
  | 'ad_product_report'
  | 'ad_search_term_report'
  | 'sales_report'
  | 'payment_report'
  | 'return_report'

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

export type RecognitionStatus = 'recognized' | 'unsupported' | 'error'
export type DateInputMode = 'single_manual' | 'single_auto' | 'range_manual' | 'range_auto' | 'multi_auto'
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
  detectedDate: string | null
  detectedCountry: string | null
  userReportDate: string | null
  fileCommitStatus: CommitStatus
  commitError: string | null
  error: string | null
}

// 需要日期的报表类型
export const DATE_REQUIRED_REPORT_TYPES: ReportType[] = [
  'business_report',
  'inventory_report',
  'ad_product_report',
  'ad_search_term_report',
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
