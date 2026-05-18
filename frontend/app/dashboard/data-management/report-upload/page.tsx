'use client'

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { useSession } from 'next-auth/react'
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CircleX,
  LayoutTemplate,
  Megaphone,
  Package,
  Wallet,
} from 'lucide-react'

import { ReportUploadDropzone } from '@/components/report-upload/report-upload-dropzone'
import { ReportStatusCard } from '@/components/report-upload/report-status-card'
import {
  DEFAULT_REPORT_UPLOAD_COUNTRY,
  getReportUploadCountryLabel,
  REPORT_UPLOAD_COUNTRY_OPTIONS,
} from '@/components/report-upload/types'
import type {
  RecognitionResponse,
  ReportCardConfig,
  ReportCardState,
  ReportType,
  ReportUploadCountry,
  UploadQueueItem,
} from '@/components/report-upload/types'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  SingleDatePicker,
  formatDateInputValue,
  parseDateInputValue,
} from '@/components/ui/date-picker'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

const API_BASE = '/api/backend'
type UploadWorkspaceTab = 'upload' | 'status' | 'guide'
const UPLOAD_WORKSPACE_TAB_ORDER: UploadWorkspaceTab[] = [
  'upload',
  'status',
  'guide',
]

const REPORT_GUIDE_ITEMS = [
  {
    type: 'inventory',
    title: '库存报表',
    amazonName: '亚马逊物流库存',
    summary: '亚马逊实时导出，但我们在系统里按美国时间口径理解数据日期。',
    detail:
      '当天上午导出，对应美国时间昨天；当天下午导出，对应美国时间当天。请特别注意导出时间，建议固定在每天上午点击“请求 txt 下载”。',
    action:
      '无须当天立即真实下载，先完成请求即可；也可以等到周一统一下载后再入库。',
    badge: '美国时间判断',
    icon: Package,
  },
  {
    type: 'business',
    title: '业务报告',
    amazonName: '详情页面销售和流量（按子商品）',
    summary: '业务报告是唯一的特殊项，导出可用日期为 T-1。',
    detail:
      '也就是今天只能导出隔一天之前的数据。比如当前是美国时间 24 号，只能导出到 23 号，提示数据此时还不可用。',
    action: '选择日期时请按美国时间理解，避免把 T 误当成可导出日期。',
    badge: '唯一例外：T-1',
    icon: BarChart3,
  },
  {
    type: 'ad',
    title: '广告报告',
    amazonName: '系统自动生成下载',
    summary: '广告报告默认由系统自动生成并下载，日常维护成本最低。',
    detail:
      '这类报表通常不需要额外手工处理，按既定节奏定期下载并完成入库即可。',
    action: '只要保持定期下载入库即可，整体无明显操作难度。',
    badge: '自动生成',
    icon: Megaphone,
  },
  {
    type: 'payment',
    title: '付款报告',
    amazonName: '付款报告',
    summary: '原则上可直接忽略，不作为日常单独处理重点。',
    detail:
      '当前流程会直接索引到每周产品分析里的付款报告，并自动覆盖对应日期范围内的每一天。',
    action: '无需额外重复维护，除非后续流程规则变更。',
    badge: '默认忽略',
    icon: Wallet,
  },
] as const

const REPORT_CARD_CONFIGS: ReportCardConfig[] = [
  {
    type: 'inventory_report',
    title: '亚马逊物流库存',
    subtitle: '识别字段：snapshot-date / sku / asin',
    dateHint: '默认自动识别 snapshot-date，必要时可手动调整。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
  {
    type: 'business_report',
    title: '业务报告',
    subtitle: '识别字段：（子）ASIN',
    dateHint: '可自动从文件名识别日期，必要时可手动调整。',
    projectHint: '默认根据（子）ASIN 自动匹配项目。',
  },
  {
    type: 'ad_product_report',
    title: '广告 - 已推广商品',
    subtitle: '识别字段：开始日期 / 结束日期 / 广告SKU / 广告ASIN',
    dateHint: '默认取识别到的结束日期作为报表日期。',
    projectHint: '默认根据广告SKU 自动匹配项目。',
  },
  {
    type: 'sales_report',
    title: '销售报表 - 所有订单',
    subtitle: '识别字段：purchase-date / sku / asin',
    dateHint:
      '单日文件会自动带出识别日期；周期文件会锁定日期范围并可直接上传。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
  {
    type: 'payment_report',
    title: '付款报告',
    subtitle: '识别字段：sku',
    dateHint: '该报表默认使用日期范围，请直接选择开始日期与结束日期。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
  {
    type: 'return_report',
    title: '退货明细',
    subtitle: '识别字段：return-date / sku',
    dateHint: '默认自动识别 return-date 范围，周期文件直接入库。',
    projectHint: '默认根据 SKU 自动匹配项目。',
  },
]

const REPORT_TYPES = REPORT_CARD_CONFIGS.map((item) => item.type)

type StatusCell = {
  report_type: ReportType | 'unknown'
  status: 'available' | 'missing' | 'saved_only'
  display_date: string | null
  report_start_date: string | null
  report_end_date: string | null
  source_table: string | null
  updated_at: string | null
  original_filename: string | null
  message: string | null
}

type StatusProjectRow = {
  project_id: number
  project_name: string
  statuses: Record<string, StatusCell>
}

// Timezone utilities — all dates are calculated in the marketplace timezone (country),
// not the browser's local timezone, to match backend interpretation.
const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/Los_Angeles',
  DE: 'Europe/Berlin',
  UK: 'Europe/London',
}

/** Returns today's calendar date as a Date in local time, calculated in the country's timezone. */
function getTodayInTimezone(country: string): Date {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz }) // YYYY-MM-DD in target TZ
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

/** Formats a Date as YYYY-MM-DD in the country's timezone. */
function formatDateInTimezone(date: Date, country: string): string {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  return formatter.format(date)
}

function toLocalDateInputValue(input?: Date, country?: string): string {
  const date = input ?? (country ? getTodayInTimezone(country) : new Date())
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDateString(value: string, offsetDays: number, country?: string): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year!, (month! || 1) - 1, day! || 1)
  date.setDate(date.getDate() + offsetDays)
  return toLocalDateInputValue(date, country)
}

function createEmptyCardState(): Record<ReportType, ReportCardState> {
  return {
    inventory_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    business_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    ad_product_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    ad_search_term_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    sales_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    payment_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
    return_report: {
      recognition: null,
      candidates: [],
      activeTempFileId: null,
      selectedProject: '',
      reportDate: '',
      reportStartDate: '',
      reportEndDate: '',
      commitStatus: 'idle',
      commitMessage: null,
    },
  }
}

function updateCardFromCandidates(
  state: ReportCardState,
  candidates: RecognitionResponse[],
  preferredTempFileId?: string | null,
): ReportCardState {
  const active =
    candidates.find((item) => item.temp_file_id === preferredTempFileId) ||
    candidates[candidates.length - 1] ||
    null
  const nextProject =
    state.selectedProject ||
    (active?.project_match.status === 'matched'
      ? active.project_match.project_name || ''
      : '')
  const nextDate =
    state.reportDate ||
    (active?.date_input_mode === 'single_auto'
      ? active.detected_date || active.detected_end_date || ''
      : '')
  const nextStartDate =
    state.reportStartDate || active?.detected_start_date || ''
  const nextEndDate = state.reportEndDate || active?.detected_end_date || ''

  return {
    ...state,
    candidates,
    recognition: active,
    activeTempFileId: active?.temp_file_id || null,
    selectedProject: nextProject,
    reportDate: nextDate,
    reportStartDate: nextStartDate,
    reportEndDate: nextEndDate,
    commitStatus: candidates.length === 0 ? 'idle' : state.commitStatus,
    commitMessage: candidates.length === 0 ? null : state.commitMessage,
  }
}

/**
 * Check if a report type can commit multiple files at once.
 * This is allowed when multiple files are uploaded and all have:
 * - A matched project (same project name)
 * - Valid dates (either multi_auto mode or detected dates are present)
 */
function canMultiCommit(type: ReportType, state: ReportCardState): boolean {
  if (state.candidates.length <= 1) return false
  if (!state.selectedProject) return false

  // Only sales_report, ad_product_report and business_report support multi-commit
  if (
    type !== 'sales_report' &&
    type !== 'ad_product_report' &&
    type !== 'business_report'
  )
    return false

  // Check all candidates have consistent project match
  const allSameProject = state.candidates.every(
    (c) =>
      c.project_match.status === 'matched' &&
      c.project_match.project_name === state.selectedProject,
  )
  if (!allSameProject) return false

  // Check dates are valid for all candidates
  return state.candidates.every((c) => {
    if (c.date_input_mode === 'multi_auto') return true
    if (c.date_input_mode === 'range_auto' || c.date_input_mode === 'range_manual') {
      return Boolean(state.reportStartDate && state.reportEndDate)
    }
    return Boolean(state.reportDate || c.detected_date || c.detected_end_date)
  })
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
}

function resolveRecognizedProjectLabel(recognition: RecognitionResponse): string | null {
  const projectMatch = recognition.project_match
  if (projectMatch.status === 'matched' && projectMatch.project_name) {
    return projectMatch.project_name
  }
  if (projectMatch.status === 'conflict') {
    return `候选项目 ${projectMatch.candidate_projects.length} 个`
  }
  if (projectMatch.status === 'unmatched') {
    return '未匹配到项目'
  }
  if (projectMatch.status === 'manual') {
    return '需手动选择项目'
  }
  return null
}

export default function ReportUploadPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  const [cards, setCards] =
    useState<Record<ReportType, ReportCardState>>(createEmptyCardState)
  const [statusRows, setStatusRows] = useState<StatusProjectRow[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusDate, setStatusDate] = useState(() => toLocalDateInputValue(undefined, DEFAULT_REPORT_UPLOAD_COUNTRY))
  const [selectedStatusProjects, setSelectedStatusProjects] = useState<string[]>(
    [],
  )
  const [selectedCountry, setSelectedCountry] = useState<ReportUploadCountry>(
    DEFAULT_REPORT_UPLOAD_COUNTRY,
  )
  const [workspaceTab, setWorkspaceTab] = useState<UploadWorkspaceTab>('upload')

  // Sync statusDate to "today in the new country" whenever country changes.
  useEffect(() => {
    setStatusDate(toLocalDateInputValue(undefined, selectedCountry))
  }, [selectedCountry])

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const payload =
          await fetchManagedProjectsCached<Array<{ name: string }>>(session)
        setProjects(payload.map((item) => item.name).filter(Boolean))
      } catch (error) {
        setProjectLoadError(
          normalizeErrorMessage(error, '项目列表加载失败'),
        )
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    const loadStatus = async () => {
      setStatusLoading(true)
      setStatusError(null)
      try {
        const query = new URLSearchParams({
          report_date: statusDate,
          country: selectedCountry,
        })
        const response = await fetch(
          `${API_BASE}/api/v1/report-upload/status?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as { items: StatusProjectRow[] }
        setStatusRows(payload.items || [])
      } catch (error) {
        setStatusError(
          normalizeErrorMessage(error, '报表状态加载失败'),
        )
      } finally {
        setStatusLoading(false)
      }
    }
    void loadStatus()
  }, [statusDate, selectedCountry])

  useEffect(() => {
    setSelectedStatusProjects((prev) =>
      prev.filter((project) => projects.includes(project)),
    )
  }, [projects])

  const readyCount = useMemo(() => {
    return REPORT_TYPES.filter((type) => {
      const state = cards[type]
      if (
        !state.recognition ||
        state.commitStatus === 'success' ||
        state.commitStatus === 'saving'
      )
        return false
      if (!state.selectedProject) return false

      const isMulti = canMultiCommit(type, state)
      if (state.candidates.length > 1) {
        // multi-commit: all candidates must have valid dates
        return isMulti && state.candidates.every((c) => {
          if (c.date_input_mode === 'multi_auto') return true
          if (c.date_input_mode === 'range_auto' || c.date_input_mode === 'range_manual') {
            return Boolean(state.reportStartDate && state.reportEndDate)
          }
          return Boolean(state.reportDate || c.detected_date || c.detected_end_date)
        })
      }

      // single-commit
      if (state.recognition.date_input_mode === 'range_auto' || state.recognition.date_input_mode === 'range_manual') {
        return Boolean(state.reportStartDate && state.reportEndDate)
      }
      if (state.recognition.date_input_mode === 'multi_auto') {
        return true
      }
      return Boolean(state.reportDate || state.recognition.detected_date || state.recognition.detected_end_date)
    }).length
  }, [cards])

  const uploadingAny = useMemo(
    () => REPORT_TYPES.some((type) => cards[type].commitStatus === 'saving'),
    [cards],
  )

  const applyRecognition = (recognition: RecognitionResponse) => {
    if (recognition.report_type === 'unknown') return

    setCards((prev) => {
      const type = recognition.report_type as ReportType
      const existing = prev[type]
      const filtered = existing.candidates.filter(
        (item) => item.temp_file_id !== recognition.temp_file_id,
      )
      const candidates = [...filtered, recognition]
      return {
        ...prev,
        [type]: updateCardFromCandidates(
          existing,
          candidates,
          recognition.temp_file_id,
        ),
      }
    })
  }

  const recognizeFiles = async (files: File[]) => {
    if (!files.length) return

     const pendingItems: UploadQueueItem[] = files.map((file) => ({
      localId: crypto.randomUUID(),
      originalFileName: file.name,
      reportType: null,
      recognitionStatus: 'pending',
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
      error: null,
    }))
    setQueueItems((prev) => [...pendingItems, ...prev])
    setRecognizing(true)

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const queueItem = pendingItems[index]
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('country', selectedCountry)
        const response = await fetch(
          `${API_BASE}/api/v1/report-upload/recognize`,
          {
            method: 'POST',
            body: formData,
          },
        )
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const recognition = (await response.json()) as RecognitionResponse
        setQueueItems((prev) =>
          prev.map((item) =>
            item.localId === queueItem.localId
                 ? {
                  ...item,
                  tempFileId: recognition.temp_file_id,
                  reportType: recognition.report_type,
                  recognitionStatus: recognition.status,
                  recognizedProject: resolveRecognizedProjectLabel(recognition),
                  detectedDate: recognition.detected_date || recognition.detected_end_date || null,
                  detectedStartDate: recognition.detected_start_date || null,
                  detectedEndDate: recognition.detected_end_date || null,
                  detectedCountry: recognition.country,
                  detectedCountries: recognition.detected_countries ?? [],
                  isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
                  userReportDate: null,
                  userReportStartDate: null,
                  userReportEndDate: null,
                  fileCommitStatus: 'idle',
                  commitError: null,
                  error:
                    recognition.status === 'recognized'
                      ? null
                      : recognition.reason,
                }
              : item,
          ),
        )
        if (recognition.status === 'recognized') {
          applyRecognition(recognition)
        }
      } catch (error) {
        setQueueItems((prev) =>
          prev.map((item) =>
            item.localId === queueItem.localId
                ? {
                  ...item,
                  reportType: 'unknown',
                  recognitionStatus: 'error',
                  recognizedProject: null,
                  fileCommitStatus: 'error',
                  commitError: normalizeErrorMessage(error, '识别失败'),
                  error: normalizeErrorMessage(error, '识别失败'),
                }
              : item,
          ),
        )
      }
    }

    setRecognizing(false)
  }

  const onPickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    await recognizeFiles(files)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await recognizeFiles(Array.from(event.dataTransfer.files || []))
  }

  const removeFile = (localId: string) => {
    const target = queueItems.find((item) => item.localId === localId)
    setQueueItems((prev) => prev.filter((item) => item.localId !== localId))
    if (
      !target?.tempFileId ||
      !target.reportType ||
      target.reportType === 'unknown'
    )
      return

    setCards((prev) => {
      const type = target.reportType as ReportType
      const nextCandidates = prev[type].candidates.filter(
        (item) => item.temp_file_id !== target.tempFileId,
      )
      return {
        ...prev,
        [type]: updateCardFromCandidates(
          prev[type],
          nextCandidates,
          prev[type].activeTempFileId,
        ),
      }
    })
  }

  const clearAll = () => {
    setQueueItems([])
    setCards(createEmptyCardState())
  }

  const updateCard = (
    type: ReportType,
    updater: (state: ReportCardState) => ReportCardState,
  ) => {
    setCards((prev) => ({
      ...prev,
      [type]: updater(prev[type]),
    }))
  }

  const commitCard = async (type: ReportType) => {
    const state = cards[type]
    const recognition = state.recognition
    if (!recognition) return

    // 防呆检查：检查所有待提交文件的检测国家是否与所选站点匹配
    const candidatesToCheck = (type === 'sales_report' || type === 'ad_product_report') &&
      state.candidates.length > 1
      ? state.candidates
      : [recognition]

    const countryMismatch = candidatesToCheck.find(
      (c) => c.country && c.country !== selectedCountry,
    )
    if (countryMismatch) {
      updateCard(type, (current) => ({
        ...current,
        commitStatus: 'error',
        commitMessage: `文件站点（${countryMismatch.country}）与所选站点（${selectedCountry}）不一致，请上传到对应站点`,
      }))
      return
    }

    const isMultiCommit =
      (type === 'sales_report' || type === 'ad_product_report') &&
      state.candidates.length > 1 &&
      canMultiCommit(type, state)

    const candidatesToCommit = isMultiCommit
      ? state.candidates
      : [recognition]
    const candidateTempFileIds = new Set(
      candidatesToCommit.map((item) => item.temp_file_id),
    )

    updateCard(type, (current) => ({
      ...current,
      commitStatus: 'saving',
      commitMessage: null,
    }))
    setQueueItems((prev) =>
      prev.map((item) =>
        item.tempFileId && candidateTempFileIds.has(item.tempFileId)
          ? { ...item, fileCommitStatus: 'saving', commitError: null }
          : item,
      ),
    )

    let hasError = false
    let lastErrorMessage: string | null = null

    for (const candidate of candidatesToCommit) {
      try {
        // For ad_product_report multi-commit, let backend derive date from file
        const shouldDeriveDateFromFile =
          type === 'ad_product_report' && isMultiCommit
        // For business_report multi-commit, each candidate has its own detected_date from filename
        const isBusinessReportMultiCommit =
          type === 'business_report' && isMultiCommit
        const payload = {
          temp_file_id: candidate.temp_file_id,
          original_filename: candidate.original_filename,
          report_type: type,
          project_name: state.selectedProject,
          report_date: shouldDeriveDateFromFile
            ? null
            : isBusinessReportMultiCommit
              ? (candidate.detected_date || null)
              : (state.reportDate || null),
          report_start_date: shouldDeriveDateFromFile ? null : (state.reportStartDate || null),
          report_end_date: shouldDeriveDateFromFile ? null : (state.reportEndDate || null),
          country: selectedCountry,
        }
        const response = await fetch(`${API_BASE}/api/v1/report-upload/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        setQueueItems((prev) =>
          prev.map((item) =>
            item.tempFileId === candidate.temp_file_id
              ? { ...item, fileCommitStatus: 'success', commitError: null }
              : item,
          ),
        )
      } catch (error) {
        hasError = true
        const errorMessage = normalizeErrorMessage(error, '保存失败')
        lastErrorMessage = errorMessage
        setQueueItems((prev) =>
          prev.map((item) =>
            item.tempFileId === candidate.temp_file_id
              ? {
                  ...item,
                  fileCommitStatus: 'error',
                  commitError: errorMessage,
                }
              : item,
          ),
        )
      }
    }

    if (hasError) {
      updateCard(type, (current) => ({
        ...current,
        commitStatus: 'error',
        commitMessage: lastErrorMessage,
      }))
    } else {
      updateCard(type, (current) => ({
        ...current,
        commitStatus: 'success',
        commitMessage:
          candidatesToCommit.length > 1
            ? `已保存 ${candidatesToCommit.length} 个文件`
            : '保存成功',
      }))
    }

    setStatusLoading(true)
    try {
      const query = new URLSearchParams({
        report_date: statusDate,
        country: selectedCountry,
      })
      const refresh = await fetch(
        `${API_BASE}/api/v1/report-upload/status?${query.toString()}`,
        { cache: 'no-store' },
      )
      if (refresh.ok) {
        const refreshPayload = (await refresh.json()) as {
          items: StatusProjectRow[]
        }
        setStatusRows(refreshPayload.items || [])
        setStatusError(null)
      }
    } finally {
      setStatusLoading(false)
    }
  }

  const uploadAllReady = async () => {
    for (const type of REPORT_TYPES) {
      const state = cards[type]
      const isMulti = canMultiCommit(type, state)
      const canCommit = Boolean(
        state.recognition &&
          (state.candidates.length === 1 || isMulti) &&
          state.selectedProject &&
          (state.recognition.date_input_mode === 'range_auto' || state.recognition.date_input_mode === 'range_manual'
            ? state.reportStartDate && state.reportEndDate
            : state.recognition.date_input_mode === 'multi_auto'
              ? true
              : isMulti
                ? state.candidates.every(
                    (c) => Boolean(c.detected_date || c.detected_end_date),
                  )
                : state.reportDate || state.recognition.detected_date || state.recognition.detected_end_date) &&
          state.commitStatus !== 'success',
      )
      if (canCommit) {
        // eslint-disable-next-line no-await-in-loop
        await commitCard(type)
      }
    }
  }

  const statusLabelByType: Record<ReportType, string> = useMemo(
    () => ({
      inventory_report: '库存',
      business_report: '业务',
      ad_product_report: '广告',
      sales_report: '订单',
      ad_search_term_report: '搜索词',
      payment_report: '付款',
      return_report: '退货',
    }),
    [],
  )

  const statusTypeLabel = (cell?: StatusCell) => {
    if (!cell || cell.status === 'missing') return '未入库'
    if (
      cell.report_start_date &&
      cell.report_end_date &&
      cell.report_start_date !== cell.report_end_date
    )
      return '周期入库'
    return '当日入库'
  }

  const filteredStatusRows = useMemo(() => {
    if (selectedStatusProjects.length === 0) return statusRows
    const selected = new Set(selectedStatusProjects)
    return statusRows.filter((row) => selected.has(row.project_name))
  }, [selectedStatusProjects, statusRows])

  const statusProjectFilterLabel = useMemo(() => {
    if (selectedStatusProjects.length === 0) return '全部项目'
    if (selectedStatusProjects.length === 1) return selectedStatusProjects[0]
    return `已选 ${selectedStatusProjects.length} 个项目`
  }, [selectedStatusProjects])

  return (
    <div className='w-full space-y-6 text-foreground'>
      <Tabs
        value={workspaceTab}
        onValueChange={(value) => setWorkspaceTab(value as UploadWorkspaceTab)}
        className='space-y-5'
      >
        <TabsMotionGroup id='report-upload-tabs'>
          <TabsList className='grid h-auto w-full max-w-[540px] grid-cols-3 rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-1 shadow-none'>
            <SlidingTabsTrigger
              value='upload'
              activeValue={workspaceTab}
              layoutId='report-upload-tab-indicator'
              className='w-full'
            >
              报表上传
            </SlidingTabsTrigger>
            <SlidingTabsTrigger
              value='status'
              activeValue={workspaceTab}
              layoutId='report-upload-tab-indicator'
              className='w-full'
            >
              报表状态
            </SlidingTabsTrigger>
            <SlidingTabsTrigger
              value='guide'
              activeValue={workspaceTab}
              layoutId='report-upload-tab-indicator'
              className='w-full'
            >
              报表指引
            </SlidingTabsTrigger>
          </TabsList>
        </TabsMotionGroup>

        <DirectionalTabTransition
          value={workspaceTab}
          order={UPLOAD_WORKSPACE_TAB_ORDER}
        >
          <TabsContent forceMount value={workspaceTab} className='space-y-5'>
            {workspaceTab === 'upload' ? (
              <div className='space-y-5'>
                <ReportUploadDropzone
                  items={queueItems}
                  dragActive={dragActive}
                  recognizing={recognizing}
                  country={selectedCountry}
                  onCountryChange={(value) => setSelectedCountry(value)}
                  onDrop={onDrop}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDragActive(true)
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault()
                    setDragActive(false)
                  }}
                  onPickFiles={onPickFiles}
                  onRemove={removeFile}
                  onClear={clearAll}
                  onUploadReady={() => void uploadAllReady()}
                  onDateChange={(localId, date) => {
                    setQueueItems((prev) =>
                      prev.map((item) =>
                        item.localId === localId ? { ...item, userReportDate: date } : item,
                      ),
                    )
                  }}
                  readyCount={readyCount}
                  uploadingAny={uploadingAny}
                />

                <div className='space-y-4'>
                  <div className='flex items-end justify-between gap-3'>
                    <div className='space-y-1'>
                      <h2 className='text-lg font-semibold tracking-tight text-foreground'>
                        当前识别卡片
                      </h2>
                      <p className='text-sm text-muted-foreground'>
                        每张卡片对应一类报表，识别完成后即可确认项目和日期。
                      </p>
                    </div>
                    {projectLoadError ? (
                      <p className='text-sm text-destructive'>
                        {projectLoadError}
                      </p>
                    ) : null}
                  </div>

                  {projectsLoading ? (
                    <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                      {REPORT_TYPES.map((type) => (
                        <Skeleton key={type} className='h-[320px] rounded-xl' />
                      ))}
                    </div>
                  ) : (
                    <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                      {REPORT_CARD_CONFIGS.map((config) => {
                        const state = cards[config.type]
                        const recognition = state.recognition
                        const isMultiCommit =
                          (config.type === 'sales_report' ||
                            config.type === 'ad_product_report' ||
                            config.type === 'business_report') &&
                          canMultiCommit(config.type, state)
                        const canCommit = Boolean(
                          recognition &&
                            (state.candidates.length === 1 || isMultiCommit) &&
                            state.selectedProject &&
                            (recognition.date_input_mode === 'range_auto' || recognition.date_input_mode === 'range_manual'
                              ? state.reportStartDate && state.reportEndDate
                              : recognition.date_input_mode === 'multi_auto'
                                ? true
                                : isMultiCommit
                                  ? state.candidates.every(
                                      (c) => Boolean(c.detected_date || c.detected_end_date),
                                    )
                                  : state.reportDate || recognition.detected_date || recognition.detected_end_date),
                        )

                        return (
                          <ReportStatusCard
                            key={config.type}
                            config={config}
                            state={state}
                            projects={projects}
                            onPickCandidate={(tempFileId) =>
                              updateCard(config.type, (current) =>
                                updateCardFromCandidates(
                                  current,
                                  current.candidates,
                                  tempFileId,
                                ),
                              )
                            }
                            onProjectChange={(value) =>
                              updateCard(config.type, (current) => ({
                                ...current,
                                selectedProject: value,
                              }))
                            }
                            onDateChange={(field, value) =>
                              updateCard(config.type, (current) => ({
                                ...current,
                                [field]: value,
                              }))
                            }
                            onCommit={() => void commitCard(config.type)}
                            canCommit={canCommit}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : workspaceTab === 'status' ? (
              <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
                <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-5 md:px-8'>
                  <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
                    <div className='flex items-center gap-3'>
                      <div className='flex h-11 w-11 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground'>
                        <LayoutTemplate className='h-5 w-5' />
                      </div>
                      <div className='space-y-1'>
                        <CardTitle>报表状态</CardTitle>
                        <p className='text-sm text-muted-foreground'>
                          按日期和站点切换查看各项目的入库情况。
                        </p>
                      </div>
                    </div>

                    <div className='flex flex-wrap items-center gap-2 lg:justify-end'>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type='button'
                            variant='outline'
                            className='h-10 min-w-[180px] justify-start border-border/70 bg-background text-left font-normal dark:bg-[hsl(var(--surface-soft))]'
                          >
                            {statusProjectFilterLabel}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align='end'
                          className='w-[280px]'
                        >
                          <DropdownMenuLabel>项目筛选</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <button
                            type='button'
                            className='w-full rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground'
                            onClick={() => setSelectedStatusProjects([])}
                          >
                            全部项目
                          </button>
                          <DropdownMenuSeparator />
                          {projects.length > 0 ? (
                            projects.map((project) => (
                              <DropdownMenuCheckboxItem
                                key={project}
                                checked={selectedStatusProjects.includes(
                                  project,
                                )}
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => {
                                  setSelectedStatusProjects((prev) => {
                                    if (checked) {
                                      return prev.includes(project)
                                        ? prev
                                        : [...prev, project]
                                    }
                                    return prev.filter(
                                      (item) => item !== project,
                                    )
                                  })
                                }}
                              >
                                {project}
                              </DropdownMenuCheckboxItem>
                            ))
                          ) : (
                            <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                              暂无可筛选项目
                            </div>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Select
                        value={selectedCountry}
                        onValueChange={(value) =>
                          setSelectedCountry(value as ReportUploadCountry)
                        }
                      >
                        <SelectTrigger className='h-10 w-[160px] rounded-md border-border/70 bg-background dark:bg-[hsl(var(--surface-soft))]'>
                          <SelectValue placeholder='选择站点' />
                        </SelectTrigger>
                        <SelectContent>
                          {REPORT_UPLOAD_COUNTRY_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        onClick={() =>
                          setStatusDate((current) =>
                            shiftDateString(current, -1, selectedCountry),
                          )
                        }
                      >
                        <ChevronLeft className='h-4 w-4' />
                      </Button>
                      <SingleDatePicker
                        value={parseDateInputValue(statusDate)}
                        onChange={(date) =>
                          setStatusDate(formatDateInputValue(date))
                        }
                        className='w-[180px] bg-background dark:bg-[hsl(var(--surface-soft))]'
                      />
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        onClick={() =>
                          setStatusDate((current) =>
                            shiftDateString(current, 1, selectedCountry),
                          )
                        }
                      >
                        <ChevronRight className='h-4 w-4' />
                      </Button>
                      <Button
                        type='button'
                        variant='secondary'
                        onClick={() => setStatusDate(toLocalDateInputValue(undefined, selectedCountry))}
                      >
                        今天
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className='space-y-4 px-6 py-8 md:px-8'>
                  {statusError ? (
                    <p className='mb-4 text-sm text-rose-600'>{statusError}</p>
                  ) : null}
                  {statusLoading ? (
                    <div className='space-y-3'>
                      <Skeleton className='h-12 rounded-lg' />
                      <Skeleton className='h-72 rounded-xl' />
                    </div>
                  ) : (
                    <ScrollArea className='mt-4 w-full'>
                      <div className='min-w-[920px] space-y-3'>
                        <div className='grid grid-cols-[160px_repeat(6,minmax(110px,1fr))] gap-2 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground'>
                          <div>项目</div>
                          {REPORT_TYPES.map((type) => (
                            <div key={type}>{statusLabelByType[type]}</div>
                          ))}
                        </div>

                        {filteredStatusRows.length === 0 ? (
                          <div className='rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-12 text-center'>
                            <p className='text-base font-medium'>
                              {statusDate} 暂时没有可展示的报表状态
                            </p>
                            <p className='mt-2 text-sm text-muted-foreground'>
                              切换左右日期，或先在“报表上传”页签完成当天报表上传。
                            </p>
                          </div>
                        ) : null}

                          {filteredStatusRows.map((row) => (
                            <div
                              key={row.project_id}
                              className='grid grid-cols-[160px_repeat(6,minmax(110px,1fr))] gap-2 rounded-xl border border-border/60 bg-[hsl(var(--surface-panel))] p-2.5'
                            >
                              <div className='rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5'>
                              <p className='text-sm font-semibold'>
                                {row.project_name}
                              </p>
                              <p className='mt-1 text-xs text-muted-foreground'>
                                {getReportUploadCountryLabel(
                                  selectedCountry,
                                  true,
                                )}
                              </p>
                            </div>
                            {REPORT_TYPES.map((type) => {
                              const cell = row.statuses[type] as
                                | StatusCell
                                | undefined
                              const tone =
                                cell?.status === 'available'
                                  ? 'border-emerald-500/30 bg-emerald-500/8'
                                  : cell?.status === 'saved_only'
                                    ? 'border-amber-500/30 bg-amber-500/8'
                                    : 'border-border/60 bg-[hsl(var(--surface-panel))]'
                              return (
                                <div
                                  key={type}
                                  className={`rounded-lg border px-2.5 py-2 shadow-none ${tone}`}
                                >
                                  <div className='flex items-center gap-2'>
                                    {cell?.status === 'missing' ? (
                                      <CircleX className='h-4 w-4 text-rose-500' />
                                    ) : (
                                      <CheckCircle2
                                        className={`h-4 w-4 ${cell?.status === 'saved_only' ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}`}
                                      />
                                    )}
                                    <span className='text-xs font-medium'>
                                      {cell?.status === 'available'
                                        ? '已入库'
                                        : cell?.status === 'saved_only'
                                          ? '仅文件'
                                          : '缺失'}
                                    </span>
                                  </div>
                                  <p className='mt-1.5 text-[11px] text-muted-foreground'>
                                    {statusTypeLabel(cell)}
                                  </p>
                                </div>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className='space-y-5'>
                <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm dark:border-border/90'>
                  <CardHeader className='px-6 py-6 md:px-8'>
                    <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
                      <div className='space-y-3'>
                        <div className='flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground'>
                          <BookOpen className='h-5 w-5' />
                        </div>
                        <div className='space-y-2'>
                          <CardTitle className='text-xl md:text-2xl'>
                            报表导出与入库指引
                          </CardTitle>
                        </div>
                      </div>

                      <div className='grid gap-3 sm:grid-cols-3'>
                        <div className='rounded-2xl border border-border/70 bg-background/80 px-4 py-3 backdrop-blur dark:bg-[hsl(var(--surface-soft))]/80'>
                          <p className='text-xs uppercase tracking-[0.12em] text-muted-foreground'>
                            时间口径
                          </p>
                          <p className='mt-1 text-base font-semibold'>
                            全部按美国时间 T
                          </p>
                        </div>

                        <div className='rounded-2xl border border-border/70 bg-background/80 px-4 py-3 backdrop-blur dark:bg-[hsl(var(--surface-soft))]/80'>
                          <p className='text-xs uppercase tracking-[0.12em] text-muted-foreground'>
                            特殊项
                          </p>
                          <p className='mt-1 text-base font-semibold'>
                            业务报告按 T-1
                          </p>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                </Card>

                <div className='grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]'>
                  <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm dark:border-border/90'>
                    <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-5 md:px-8'>
                      <div className='flex items-center gap-3'>
                        <div className='flex h-11 w-11 items-center justify-center rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground'>
                          <Clock3 className='h-5 w-5' />
                        </div>
                        <div className='space-y-1'>
                          <CardTitle>快速规则</CardTitle>
                          <CardDescription>
                            先看统一口径，再按报表类型执行。
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className='space-y-4 px-6 pb-6 pt-5 md:px-8 md:pb-8 md:pt-6'>
                      <div className='rounded-xl border-l-4 border-sky-500/60 bg-[hsl(var(--surface-soft))] px-4 py-4 text-sm leading-7 text-foreground'>
                        我们系统里的报表日期，统一按美国时间理解。正常情况下，除了业务报告，其他所有报告都可按美国时间
                        T 处理。
                      </div>

                      <div className='grid gap-3 md:grid-cols-2'>
                        <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4'>
                          <p className='text-sm font-semibold text-foreground'>
                            库存 / 广告 / 付款
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            默认按美国时间 T
                            理解和安排入库，其中库存报表还需要结合导出时段判断实际对应日期。
                          </p>
                        </div>
                        <div className='rounded-xl border-l-4 border-amber-500/60 bg-[hsl(var(--surface-soft))] p-4'>
                          <p className='text-sm font-semibold text-foreground'>
                            业务报告是例外
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            业务报告不是 T，而是 T-1。比如美国时间的 24
                            号只能导出到 23 号。
                          </p>
                        </div>
                      </div>

                      <div className='space-y-3'>
                        {REPORT_GUIDE_ITEMS.map((item) => {
                          const Icon = item.icon

                          return (
                            <div
                              key={item.type}
                              className='rounded-xl border border-border/60 bg-[hsl(var(--surface-panel))] p-4'
                            >
                              <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
                                <div className='flex items-start gap-3'>
                                  <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground'>
                                    <Icon className='h-4 w-4' />
                                  </div>
                                  <div className='min-w-0'>
                                    <p className='text-sm font-semibold text-foreground'>
                                      {item.title}
                                    </p>
                                    <p className='mt-1 text-xs text-muted-foreground'>
                                      {item.amazonName}
                                    </p>
                                  </div>
                                </div>
                                <div className='rounded-full border border-border/60 bg-[hsl(var(--surface-soft))] px-2.5 py-1 text-xs font-medium text-foreground/80 sm:shrink-0'>
                                  {item.badge}
                                </div>
                              </div>
                              <p className='mt-3 text-xs leading-5 text-muted-foreground'>
                                {item.summary} {item.detail}
                              </p>
                              <p className='mt-2 text-xs font-medium text-foreground/70'>
                                → {item.action}
                              </p>
                            </div>
                          )
                        })}
                      </div>
                    </CardContent>
                  </Card>

                  <div className='space-y-4'>
                    <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm dark:border-border/90'>
                      <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-5'>
                        <CardTitle>建议节奏</CardTitle>
                        <CardDescription>
                          按这个顺序做，最不容易出错。
                        </CardDescription>
                      </CardHeader>
                      <CardContent className='space-y-3 px-6 pb-6 pt-5'>
                        <div className='rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] p-4'>
                          <p className='text-sm font-semibold'>
                            1. 先确认美国时间日期
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            上传或导出前先判断当前要处理的是美国哪一天，避免把本地日期直接套进去。
                          </p>
                        </div>
                        <div className='rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] p-4'>
                          <p className='text-sm font-semibold'>
                            2. 库存报表尽量固定上午处理
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            上午点击&quot;请求 txt
                            下载&quot;更稳定，口径也更统一，后续可集中下载入库。
                          </p>
                        </div>
                        <div className='rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] p-4'>
                          <p className='text-sm font-semibold'>
                            3. 单独留意业务报告 T-1
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            这是最容易错的一类，看到当天日期时要主动往前多退一天。
                          </p>
                        </div>
                        <div className='rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] p-4'>
                          <p className='text-sm font-semibold'>
                            4. 广告与付款按既有流程维护
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            广告报告定期下载即可；付款报告默认由现有产品分析流程覆盖，无需重复操作。
                          </p>
                        </div>
                        <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4'>
                          <p className='text-sm font-semibold'>
                            2. 库存报表尽量固定上午处理
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            上午点击“请求 txt
                            下载”更稳定，口径也更统一，后续可集中下载入库。
                          </p>
                        </div>
                        <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4'>
                          <p className='text-sm font-semibold'>
                            3. 单独留意业务报告 T-1
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            这是最容易错的一类，看到当天日期时要主动往前多退一天。
                          </p>
                        </div>
                        <div className='rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4'>
                          <p className='text-sm font-semibold'>
                            4. 广告与付款按既有流程维护
                          </p>
                          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                            广告报告定期下载即可；付款报告默认由现有产品分析流程覆盖，无需重复操作。
                          </p>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className='overflow-hidden border border-amber-500/30 bg-[hsl(var(--surface-panel))] shadow-sm'>
                      <CardHeader className='px-6 py-5'>
                        <CardTitle>特别提醒</CardTitle>
                      </CardHeader>
                      <CardContent className='px-6 pb-6'>
                        <p className='text-sm leading-7 text-muted-foreground'>
                          如果页面日期、导出时间和亚马逊后台展示日期看起来不一致，优先按美国时间重新核对一次。这个页面的所有说明，都是围绕美国
                          T 时间口径整理的。
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </DirectionalTabTransition>
      </Tabs>
    </div>
  )
}
