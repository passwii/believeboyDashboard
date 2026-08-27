'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, ChangeEvent } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CalendarRange,
  CheckCircle2,
  DatabaseZap,
  Download,
  Loader2,
  Upload,
  XCircle,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  DateRangePicker,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SimpleDropzone } from '@/components/report-upload/simple-dropzone'
import { ReportStatusCard } from '@/components/report-upload/report-status-card'
import type {
  ReportCardConfig,
  ReportCardState,
  ReportType,
  ReportUploadCountry,
  RecognitionResponse,
  UploadQueueItem,
} from '@/components/report-upload/types'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'

// =============================================================================
// Types
// =============================================================================

type CountryOption = 'US' | 'DE' | 'UK'

const CURRENCY_CONFIG: Record<CountryOption, { symbol: string; excelFmt: string }> = {
  US: { symbol: '$', excelFmt: '$#,##0.00;[Red]-$#,##0.00' },
  DE: { symbol: '€', excelFmt: '#,##0.00;[Red]-#,##0.00 €' },
  UK: { symbol: '£', excelFmt: '£#,##0.00;[Red]-£,##0.00' },
}

type ProjectOption = {
  id?: number
  name: string
}

type CheckState = 'idle' | 'checking' | 'done' | 'error'
type RunState = 'idle' | 'running' | 'done' | 'error'

type DataAvailability = {
  business_report_missing: string[]
  ad_report_missing: string[]
  inventory_missing: string[]
  business_period_info: {
    period_start_date: string
    period_end_date: string
    source_id: number
    covered_dates: string[]
  }[]
  ad_period_info: {
    period_start_date: string
    period_end_date: string
    source_id: number
    covered_dates: string[]
  }[]
  business_periodic_only_missing: string[]
  ad_periodic_only_missing: string[]
  payment_periods_overlapping: {
    period_start_date: string
    period_end_date: string
    source_id: number
  }[]
  payment_full_period_covered: boolean
  payment_daily_covered_dates: string[]
  has_minimum_data: boolean
  weekly_availability: WeeklyAvailability[]
}

type WeeklyAvailability = {
  iso_year: number
  iso_week: number
  week_start_date: string
  week_end_date: string
  total_days: number
  business_report_available_days: number
  ad_report_available_days: number
  business_periodic_covered: boolean
  ad_periodic_covered: boolean
  payment_covered: boolean
  can_calculate: boolean
  is_partial: boolean
  business_missing_dates: string[]
  ad_missing_dates: string[]
}

type CalculationPeriod = {
  report_start_date: string
  report_end_date: string
  summary: Record<string, unknown>
  details: Record<string, unknown>[]
  is_partial?: boolean
  persisted?: boolean
  pt1_id?: number | null
  version?: number | null
  completeness?: {
    total_days: number
    available_business_days: number
    available_ad_days: number
    business_missing_dates: string[]
    ad_missing_dates: string[]
    payment_covered: boolean
    payment_type: string
    payment_missing: boolean
    payment_missing_dates?: string[]
  }
}

type CalculationRunResponse = {
  project_id: number
  project_name: string
  country: string
  total_periods: number
  periods: CalculationPeriod[]
}

// =============================================================================
// Constants
// =============================================================================

const API_BASE = '/api/backend'

const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

/** Report types used for product analysis calculation.
 *
 *  C 表（`ad_upload_files` / `ad_upload_promoted_product_rows`）自 2026-06-01 起承接
 *  广告数据；老 A 表（`analysis_source_files` `ad_product_report`）已下线并被 CHECK
 *  约束排除。前端手动核算面板通过 `recognizeFile` 按文件扩展名预判分流，广告报表
 *  走 `/api/v1/ad-upload/recognize`，后端返回的实际 `report_type` 即此处列出的
 *  C 表枚举值（`ad_promoted_product_report` 等）。
 */
const PRODUCT_ANALYSIS_TYPES: ReportType[] = [
  'business_report',
  'ad_promoted_product_report',
  'payment_report',
]

const PRODUCT_ANALYSIS_CARD_CONFIGS: ReportCardConfig[] = [
  {
    type: 'business_report',
    title: '业务报告',
    subtitle: '流量、销量、会话数据',
    dateHint: '单日',
    projectHint: 'ASIN 匹配项目',
  },
  {
    type: 'ad_promoted_product_report',
    title: '广告报告',
    subtitle: '广告曝光、点击、花费',
    dateHint: '单日',
    projectHint: 'SKU 匹配项目',
  },
  {
    type: 'payment_report',
    title: '付款报告',
    subtitle: '佣金、FBA 费用、退款',
    dateHint: '周期',
    projectHint: 'SKU 匹配项目',
  },
]

const DETAIL_DISPLAY_COLUMNS = [
  { key: 'SKU', label: 'SKU' },
  { key: 'ASIN', label: 'ASIN' },
  { key: '总销量', label: '总销量' },
  { key: '总销售额', label: '总销售额', fmt: 'currency' as const },
  { key: '广告花费', label: '广告花费', fmt: 'currency' as const },
  { key: '广告销售额', label: '广告销售额', fmt: 'currency' as const },
  { key: 'ACOS', label: 'ACOS', fmt: 'percent' as const },
  { key: '利润', label: '利润', fmt: 'currency' as const },
  { key: '利润率', label: '利润率', fmt: 'percent' as const },
]

// =============================================================================
// Helper functions
// =============================================================================

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

async function parseApiError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    const text = await response.text()
    if (text.trim()) return text
  }
  return fallback
}

function toDateInputValue(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getLastWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const distanceToCurrentMonday = day === 0 ? 6 : day - 1
  const currentMonday = new Date(now)
  currentMonday.setDate(now.getDate() - distanceToCurrentMonday)
  const lastWeekMonday = new Date(currentMonday)
  lastWeekMonday.setDate(currentMonday.getDate() - 7)
  const lastWeekSunday = new Date(lastWeekMonday)
  lastWeekSunday.setDate(lastWeekMonday.getDate() + 6)
  return {
    start: toDateInputValue(lastWeekMonday),
    end: toDateInputValue(lastWeekSunday),
  }
}

function formatNumber(value: unknown, fractionDigits = 2): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return num.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return `${(num * 100).toFixed(1)}%`
}

function emptyCardState(): ReportCardState {
  return {
    recognition: null,
    candidates: [],
    activeTempFileId: null,
    selectedProject: '',
    reportDate: '',
    reportStartDate: '',
    reportEndDate: '',
    commitStatus: 'idle',
    commitMessage: null,
  }
}

// =============================================================================
// Main Component
// =============================================================================

interface ManualCalculationPanelProps {
  projects?: ProjectOption[]
  projectsLoading?: boolean
  projectLoadError?: string | null
}

export default function ManualCalculationPanel(_props: ManualCalculationPanelProps) {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (
    session?.user?.operatorNameZh ||
    session?.user?.name ||
    session?.user?.email ||
    session?.user?.id ||
    ''
  ).trim()
  const initialDateRange = getLastWeekRange()

  // ── Parameter state ──
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)

  // ── Upload state ──
  const [items, setItems] = useState<UploadQueueItem[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [uploadingAny, setUploadingAny] = useState(false)

  // ── Card state (per report type) ──
  const [cards, setCards] = useState<Record<string, ReportCardState>>({
    business_report: emptyCardState(),
    ad_promoted_product_report: emptyCardState(),
    payment_report: emptyCardState(),
  })

  // ── Check & Run state ──
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  const [periods, setPeriods] = useState<CalculationPeriod[]>([])
  const [runError, setRunError] = useState<string | null>(null)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Track project id for API calls
  const selectedProject = useMemo(
    () => projects.find((p) => p.name === projectName),
    [projects, projectName]
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const periodLabel = startDate && endDate ? `${startDate} ~ ${endDate}` : ''

  // ── Committed type tracking ──
  const committedTypes = useMemo(
    () => PRODUCT_ANALYSIS_TYPES.filter((t) => cards[t]?.commitStatus === 'success'),
    [cards]
  )
  const allRequiredCommitted = committedTypes.length >= 3

  const canCheck = useMemo(
    () =>
      Boolean(selectedProject?.id) &&
      dateRangeValid &&
      allRequiredCommitted &&
      checkState !== 'checking',
    [selectedProject, dateRangeValid, allRequiredCommitted, checkState]
  )

  const canRun = useMemo(
    () => checkState === 'done' && availability?.has_minimum_data && runState !== 'running',
    [checkState, availability, runState]
  )

  // ── Load projects ──
  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(data)
      } catch (error) {
        setProjectLoadError(normalizeErrorMessage(error, '项目列表加载失败'))
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  // ── Reset downstream state when parameters change ──
  const resetDownstream = useCallback(() => {
    setCheckState('idle')
    setAvailability(null)
    setRunState('idle')
    setPeriods([])
    setExpandedIndex(null)
  }, [])

  // ── File recognition via backend ──
  // 广告报表（.xlsx/.xls）走 ad-upload 链路（C 表），其他（.csv/.txt）走 report-upload
  // 链路（业务/付款/库存/销售/退货 报表）。后端 `recognize_file` 对 .xlsx 显式返回
  // None（见 `backend/app/utils/recognition/recognizers/__init__.py:309-311`），必须
  // 在前端按扩展名预判分流，否则广告报表会被识别为 `report_type: 'unknown'`。
  const recognizeFile = useCallback(
    async (file: File): Promise<RecognitionResponse | null> => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('country', country)

      const lowerName = file.name.toLowerCase()
      const isAdExcel = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')
      const endpoint = isAdExcel ? '/api/v1/ad-upload/recognize' : '/api/v1/report-upload/recognize'

      try {
        const res = await fetch(resolveApiUrl(endpoint), {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const msg = await parseApiError(res, '识别失败')
          console.warn(`识别失败 (${file.name}): ${msg}`)
          return null
        }
        return (await res.json()) as RecognitionResponse
      } catch (err) {
        console.warn(`识别异常 (${file.name}):`, err)
        return null
      }
    },
    [country]
  )

  // ── Handle file drop/pick ──
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setRecognizing(true)

      const results = await Promise.all(
        files.map(async (file) => ({
          file,
          recognition: await recognizeFile(file),
        }))
      )

      setItems((prev) => {
        const next = [...prev]
        for (const { file, recognition } of results) {
          if (!recognition) {
            // Unrecognized file — add as unknown
            next.push({
              localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              originalFileName: file.name,
              reportType: 'unknown',
              recognitionStatus: 'error',
              recognizedProject: null,
              userSelectedProject: null,
              detectedDate: null,
              detectedStartDate: null,
              detectedEndDate: null,
              detectedCountry: null,
              detectedCountries: [],
              isMultiCountry: false,
              userReportDate: null,
              userReportStartDate: null,
              userReportEndDate: null,
              fileCommitStatus: 'idle',
              commitError: null,
              error: '识别失败',
              rowsIngested: null,
            })
            continue
          }

          // Check if this type is relevant for product analysis
          const rType = recognition.report_type as ReportType
          if (!PRODUCT_ANALYSIS_TYPES.includes(rType)) {
            next.push({
              localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              originalFileName: file.name,
              tempFileId: recognition.temp_file_id,
              reportType: rType,
              recognitionStatus: 'recognized',
              recognizedProject: recognition.project_match?.project_name ?? null,
              userSelectedProject: null,
              detectedDate: recognition.detected_date,
              detectedStartDate: recognition.detected_start_date,
              detectedEndDate: recognition.detected_end_date,
              detectedCountry: recognition.country,
              detectedCountries: recognition.detected_countries ?? [],
              isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
              userReportDate: null,
              userReportStartDate: null,
              userReportEndDate: null,
              fileCommitStatus: 'idle',
              commitError: null,
              error: `产品分析不需要此类型 (${rType})，已忽略`,
              rowsIngested: null,
            })
            continue
          }

          const item: UploadQueueItem = {
            localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            originalFileName: file.name,
            tempFileId: recognition.temp_file_id,
            reportType: rType,
            recognitionStatus: recognition.status === 'recognized' ? 'recognized' : 'error',
            recognizedProject: recognition.project_match?.project_name ?? null,
            userSelectedProject: null,
            detectedDate: recognition.detected_date,
            detectedStartDate: recognition.detected_start_date,
            detectedEndDate: recognition.detected_end_date,
            detectedCountry: recognition.country,
            detectedCountries: recognition.detected_countries ?? [],
            isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
            userReportDate: null,
            userReportStartDate: null,
            userReportEndDate: null,
            fileCommitStatus: 'idle',
            commitError: null,
            error: recognition.status !== 'recognized' ? recognition.reason : null,
            rowsIngested: null,
          }
          next.push(item)

          // Update card state
          if (recognition.status === 'recognized' && PRODUCT_ANALYSIS_TYPES.includes(rType)) {
            setCards((prev) => ({
              ...prev,
              [rType]: {
                ...prev[rType],
                recognition,
                candidates: [...(prev[rType]?.candidates ?? []), recognition],
                activeTempFileId: recognition.temp_file_id,
                selectedProject: projectName || recognition.project_match?.project_name || '',
                reportDate: recognition.detected_date || '',
                reportStartDate: recognition.detected_start_date || '',
                reportEndDate: recognition.detected_end_date || '',
                commitStatus: 'idle',
                commitMessage: null,
              },
            }))
          }
        }
        return next
      })

      setRecognizing(false)
    },
    [recognizeFile, projectName]
  )

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragActive(false)
      await addFiles(Array.from(event.dataTransfer.files ?? []))
    },
    [addFiles]
  )

  const onPickFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void addFiles(Array.from(event.target.files ?? []))
      // Reset input so same file can be re-picked
      event.target.value = ''
    },
    [addFiles]
  )

  const removeItem = useCallback((localId: string) => {
    setItems((prev) => prev.filter((item) => item.localId !== localId))
  }, [])

  const clearItems = useCallback(() => {
    setItems([])
    setCards({
      business_report: emptyCardState(),
      ad_promoted_product_report: emptyCardState(),
      payment_report: emptyCardState(),
    })
  }, [])

  const onDateChange = useCallback((localId: string, date: string | null) => {
    setItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, userReportDate: date } : item))
    )
  }, [])

  // ── Commit a card ──
  // 广告报表（`ad_promoted_product_report` 及其 9 个 C 表细分类型）走 `/api/v1/ad-upload/commit`
  // 落 C 表；其他（业务 / 付款）走 `/api/v1/report-upload/commit` 落 A 表。
  //
  // 产品分析手动核算场景：ad 报表只用于本周期的"识别 + 计算"快照，不写 C 表。
  // 通过 `dry_run: true` 让后端跳过 ad_upload_files 落库与版本号占用，识别仍然完整。
  // 真正的入库仍走 /dashboard/reports/auto-upload 页面。
  const commitCard = useCallback(
    async (reportType: ReportType) => {
      const card = cards[reportType]
      if (!card?.activeTempFileId) return

      setCards((prev) => ({
        ...prev,
        [reportType]: { ...prev[reportType], commitStatus: 'saving', commitMessage: null },
      }))

      try {
        const isAdReport = String(reportType).startsWith('ad_')
        const body: Record<string, unknown> = isAdReport
          ? {
              temp_file_id: card.activeTempFileId,
              report_type: reportType,
              project_name: projectName,
              country,
              report_start_date: startDate,
              report_end_date: endDate,
              dry_run: true,
            }
          : {
              temp_file_id: card.activeTempFileId,
              report_type: reportType,
              project_name: projectName,
              country,
              report_start_date: startDate,
              report_end_date: endDate,
              use_period_dates: true,
            }

        const endpoint = isAdReport ? '/api/v1/ad-upload/commit' : '/api/v1/report-upload/commit'

        const res = await fetch(resolveApiUrl(endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const msg = await parseApiError(res, '提交失败')
          throw new Error(msg)
        }

        setCards((prev) => ({
          ...prev,
          [reportType]: {
            ...prev[reportType],
            commitStatus: 'success',
            commitMessage: null,
          },
        }))

        // Mark items as committed
        setItems((prev) =>
          prev.map((item) =>
            item.tempFileId === card.activeTempFileId
              ? { ...item, fileCommitStatus: 'success' as const }
              : item
          )
        )

        // Reset downstream state
        resetDownstream()
      } catch (err) {
        const msg = err instanceof Error ? err.message : '提交失败'
        setCards((prev) => ({
          ...prev,
          [reportType]: {
            ...prev[reportType],
            commitStatus: 'error',
            commitMessage: msg,
          },
        }))
      }
    },
    [cards, projectName, country, startDate, endDate, resetDownstream]
  )

  // ── Upload all ready cards ──
  const uploadAllReady = useCallback(async () => {
    setUploadingAny(true)
    for (const rt of PRODUCT_ANALYSIS_TYPES) {
      const card = cards[rt]
      if (card?.activeTempFileId && card.commitStatus !== 'success') {
        // eslint-disable-next-line no-await-in-loop
        await commitCard(rt)
      }
    }
    setUploadingAny(false)
  }, [cards, commitCard])

  const readyCount = useMemo(
    () =>
      PRODUCT_ANALYSIS_TYPES.filter(
        (t) => cards[t]?.activeTempFileId && cards[t]?.commitStatus !== 'success'
      ).length,
    [cards]
  )

  // ── Auto-check after all types committed ──
  useEffect(() => {
    if (allRequiredCommitted && selectedProject?.id && dateRangeValid && checkState === 'idle') {
      void handleCheck()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequiredCommitted, selectedProject, dateRangeValid])

  // ── Handle check data ──
  const handleCheck = useCallback(async () => {
    if (!selectedProject?.id) return

    setCheckState('checking')
    setCheckError(null)
    setAvailability(null)
    setRunState('idle')
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(resolveApiUrl('/api/v1/product-analysis/calculation/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '检查数据失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '检查数据失败')
      }

      const data: DataAvailability = await res.json()
      setAvailability(data)
      setCheckState('done')
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : '检查数据失败')
      setCheckState('error')
    }
  }, [selectedProject, country, startDate, endDate])

  // ── Handle run calculation ──
  const handleRun = useCallback(async () => {
    if (!selectedProject?.id) return

    setRunState('running')
    setRunError(null)
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(resolveApiUrl('/api/v1/product-analysis/calculation/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
          current_only: true,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '执行核算失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '执行核算失败')
      }

      const data: CalculationRunResponse = await res.json()
      setPeriods(data.periods || [])
      setRunState('done')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : '执行核算失败')
      setRunState('error')
    }
  }, [selectedProject, country, startDate, endDate])

  // ── Handle export ──
  const handleExport = useCallback(async () => {
    if (periods.length === 0) return

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    wb.creator = 'BelieveBoy'
    wb.created = new Date()

    const projectLabel = projectName || '未知项目'
    const summarySheet = wb.addWorksheet('汇总')
    const detailSheet = wb.addWorksheet('SKU明细')

    const startDateCompact = startDate.replaceAll('-', '')
    const endDateCompact = endDate.replaceAll('-', '')
    const safeProjectName = projectLabel.replace(/[\\/:*?"<>|]/g, '-')
    const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
    const filename = `${safeProjectName}_${safeCountryLabel}-产品核算-${startDateCompact}~${endDateCompact}.xlsx`

    summarySheet.getCell(1, 1).value = `共 ${periods.length} 个周期`

    const headers = [
      '周期',
      'SKU',
      'ASIN',
      '总销量',
      '总销售额',
      '广告花费',
      'ACOS',
      '利润',
      '利润率',
    ]
    headers.forEach((header, idx) => {
      const cell = detailSheet.getCell(1, idx + 1)
      cell.value = header
      cell.font = { bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    })

    let rowIdx = 2
    periods.forEach((period) => {
      period.details.forEach((detail) => {
        detailSheet.getCell(rowIdx, 1).value =
          `${period.report_start_date} ~ ${period.report_end_date}`
        detailSheet.getCell(rowIdx, 2).value = String(detail['SKU'] ?? '')
        detailSheet.getCell(rowIdx, 3).value = String(detail['ASIN'] ?? '')
        detailSheet.getCell(rowIdx, 4).value = Number(detail['总销量'] ?? 0)
        detailSheet.getCell(rowIdx, 5).value = Number(detail['总销售额'] ?? 0)
        detailSheet.getCell(rowIdx, 6).value = Number(detail['广告花费'] ?? 0)
        detailSheet.getCell(rowIdx, 7).value = Number(detail['ACOS'] ?? 0)
        detailSheet.getCell(rowIdx, 8).value = Number(detail['利润'] ?? 0)
        detailSheet.getCell(rowIdx, 9).value = Number(detail['利润率'] ?? 0)
        rowIdx += 1
      })
    })

    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }, [periods, projectName, country, startDate, endDate])

  // ── Render helpers ──
  function renderCell(value: unknown, fmt?: 'percent' | 'currency') {
    if (value === null || value === undefined)
      return <span className="text-muted-foreground">-</span>
    if (fmt === 'percent') return <span>{formatPercent(value)}</span>
    if (fmt === 'currency') {
      const sym = CURRENCY_CONFIG[country].symbol
      return (
        <span>
          {sym}
          {formatNumber(value)}
        </span>
      )
    }
    return <span>{formatNumber(value)}</span>
  }

  const detailColCount = DETAIL_DISPLAY_COLUMNS.length

  // ── Render ──
  return (
    <div className="space-y-3">
      {/* ═══ Panel 1: Parameters ═══ */}
      <TermPanel
        title="核算参数"
        bodyClassName="p-3 space-y-3 [&_label]:font-mono [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wider [&_label]:text-term-muted"
      >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {/* Project */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                项目
              </label>
              <Select
                value={projectName}
                onValueChange={(value) => {
                  setProjectName(value)
                  // Update card projects
                  setCards((prev) => {
                    const next = { ...prev }
                    for (const key of PRODUCT_ANALYSIS_TYPES) {
                      if (next[key]) next[key] = { ...next[key], selectedProject: value }
                    }
                    return next
                  })
                  resetDownstream()
                }}
                disabled={projectsLoading || projects.length === 0}
              >
                <SelectTrigger className="h-8 max-w-full">
                  <SelectValue
                    placeholder={
                      projectsLoading
                        ? '项目加载中...'
                        : projects.length
                          ? '请选择项目名称'
                          : '暂无可选项目'
                    }
                  />
                </SelectTrigger>
                <SelectContent className="max-h-64 overflow-y-auto">
                  {projects.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Country */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                站点
              </label>
              <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                <SelectTrigger className="h-8 max-w-full">
                  <SelectValue placeholder="请选择国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date Range */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                日期范围
              </label>
              <DateRangePicker
                value={parseDateRangeInputValue(startDate, endDate)}
                onChange={(range) => {
                  setStartDate(formatDateInputValue(range?.from) ?? startDate)
                  setEndDate(formatDateInputValue(range?.to) ?? endDate)
                  resetDownstream()
                }}
                className="h-8"
              />
              {startDate && endDate && startDate > endDate && (
                <p className="text-xs text-destructive">开始日期不能晚于结束日期</p>
              )}
            </div>

            {/* Quick action */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                快捷
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const range = getLastWeekRange()
                  setStartDate(range.start)
                  setEndDate(range.end)
                  resetDownstream()
                }}
                className="w-full h-8"
              >
                <CalendarRange className="mr-1 h-4 w-4" />
                上周
              </Button>
            </div>
          </div>

          {/* Status indicators */}
          <div className="grid gap-2 sm:grid-cols-3">
            {PRODUCT_ANALYSIS_CARD_CONFIGS.map((config) => {
              const card = cards[config.type]
              const status = card?.commitStatus ?? 'idle'
              return (
                <div
                  key={config.type}
                  className="rounded-none border border-term-border bg-term-raised px-2 py-1.5"
                >
                  <p className="font-mono text-[10px] uppercase tracking-wider text-term-faint">{config.title}</p>
                  <p
                    className={cn(
                      'mt-1 font-mono text-sm font-semibold tabular-nums',
                      status === 'success'
                        ? 'text-term-pos'
                        : status === 'saving'
                          ? 'text-term-accent'
                          : status === 'error'
                            ? 'text-term-neg'
                            : 'text-term-muted'
                    )}
                  >
                    {status === 'success'
                      ? '已提交'
                      : status === 'saving'
                        ? '提交中'
                        : status === 'error'
                          ? '提交失败'
                          : '未提交'}
                  </p>
                </div>
              )
            })}
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              {formError}
            </div>
          )}
      </TermPanel>

      {/* ═══ Panel 2: File Upload & Recognition ═══ */}
      <TermPanel title="文件上传与识别" bodyClassName="p-3 space-y-4">
          <SimpleDropzone
            dragActive={dragActive}
            recognizing={recognizing}
            onDrop={onDrop}
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragActive(false)
            }}
            onPickFiles={onPickFiles}
          />

          {/* Report Status Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            {PRODUCT_ANALYSIS_CARD_CONFIGS.map((config) => {
              const cardState = cards[config.type] ?? emptyCardState()
              return (
                <ReportStatusCard
                  key={config.type}
                  config={config}
                  state={cardState}
                  projects={projectName ? [projectName] : []}
                  onPickCandidate={(tempFileId) => {
                    setCards((prev) => ({
                      ...prev,
                      [config.type]: {
                        ...prev[config.type],
                        activeTempFileId: tempFileId,
                        recognition:
                          prev[config.type]?.candidates.find(
                            (c) => c.temp_file_id === tempFileId
                          ) ?? null,
                        commitStatus: 'idle',
                        commitMessage: null,
                      },
                    }))
                  }}
                  onProjectChange={() => {}}
                  onDateChange={() => {}}
                  onCommit={() => void commitCard(config.type)}
                  canCommit={Boolean(
                    cardState.activeTempFileId &&
                      projectName &&
                      cardState.commitStatus !== 'saving' &&
                      cardState.commitStatus !== 'success'
                  )}
                  projectLocked={true}
                  datesLocked={true}
                  periodLabel={periodLabel}
                />
              )
            })}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleCheck()}
              disabled={!canCheck}
            >
              {checkState === 'checking' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              检查数据
            </Button>

            <Button type="button" onClick={() => void handleRun()} disabled={!canRun}>
              {runState === 'running' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              执行核算
            </Button>
          </div>

          {checkError && (
            <div className="flex items-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              {checkError}
            </div>
          )}

          {runError && (
            <div className="flex items-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              {runError}
            </div>
          )}
      </TermPanel>

      {/* ═══ Panel 3: Data Availability ═══ */}
      {availability && (
        <TermPanel title={`数据可用性 ${startDate} — ${endDate}`} bodyClassName="p-3 space-y-3">
            <div className="flex items-center gap-2 border-t border-term-border pt-2 font-mono text-xs">
              {availability.has_minimum_data ? (
                <div className="flex items-center gap-1.5 font-medium text-term-pos">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  可执行核算
                </div>
              ) : (
                <div className="flex items-center gap-1.5 font-medium text-term-neg">
                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                  数据不足，无法执行核算（缺少核心报表数据）
                </div>
              )}
            </div>
        </TermPanel>
      )}

      {/* ═══ Panel 4: Results ═══ */}
      {runState === 'done' && (
        <TermPanel
          title={`核算结果 · 共 ${periods.length} 个周期`}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleExport()}
              disabled={periods.length === 0}
            >
              <Download className="mr-1 h-4 w-4" aria-hidden />
              导出 Excel
            </Button>
          }
        >
          <div className="p-3">
            {periods.length === 0 ? (
              <div className="py-8 text-center font-mono text-sm text-term-faint">无核算数据</div>
            ) : (
              <div className="space-y-3">
                {periods.map((period, idx) => {
                  const isExpanded = expandedIndex === idx
                  return (
                    <div key={idx} className="space-y-1">
                      <div
                        className={`flex flex-wrap items-center gap-2 rounded-none border px-2 py-1.5 font-mono text-xs transition-colors ${
                          isExpanded
                            ? 'border-term-border-strong bg-term-raised text-term-text'
                            : 'border-term-border bg-term-panel text-term-muted hover:bg-term-hover'
                        }`}
                        onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                      >
                        <button
                          className="rounded-none p-0.5 hover:bg-term-hover shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedIndex(isExpanded ? null : idx)
                          }}
                        >
                          {isExpanded ? (
                            <ArrowUp className="h-4 w-4" />
                          ) : (
                            <ArrowDown className="h-4 w-4" />
                          )}
                        </button>

                        <span className="shrink-0 font-medium text-sm">
                          <span className="tabular-nums">
                            {period.report_start_date} ~ {period.report_end_date}
                          </span>
                          {period.persisted && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-none border border-term-pos/40 px-1 py-px font-mono text-[10px] leading-none text-term-pos">
                              <CheckCircle2 className="h-3 w-3" aria-hidden />
                              已写入PT1
                            </span>
                          )}
                        </span>

                        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums text-term-muted">
                          <span>总销售额: {renderCell(period.summary['总销售额'])}</span>
                          <span>利润: {renderCell(period.summary['利润'])}</span>
                          <span>利润率: {renderCell(period.summary['利润率'], 'percent')}</span>
                          <span>ACOS: {renderCell(period.summary['ACOS'], 'percent')}</span>
                        </span>
                      </div>

                      {isExpanded && (
                        <div className="overflow-x-auto rounded-none border border-term-border term-scroll">
                          <table className="w-full border-collapse font-mono text-xs tabular-nums">
                            <thead>
                              <tr className="border-b border-term-border bg-term-raised">
                                {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                  <th
                                    key={col.key}
                                    className="h-9 px-2 text-right font-medium normal-case tracking-normal whitespace-nowrap text-term-muted"
                                  >
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {period.details.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={detailColCount}
                                    className="px-3 py-4 text-center text-muted-foreground"
                                  >
                                    无 SKU 明细
                                  </td>
                                </tr>
                              ) : (
                                period.details.map((detail, dIdx) => (
                                  <tr
                                    key={dIdx}
                                    className="border-b border-term-border hover:bg-term-hover"
                                  >
                                    {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                      <td
                                        key={col.key}
                                        className="px-3 py-1.5 text-right whitespace-nowrap"
                                      >
                                        {renderCell(detail[col.key], col.fmt)}
                                      </td>
                                    ))}
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </TermPanel>
      )}
    </div>
  )
}
