'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, CalendarRange, CheckCircle2, DatabaseZap, Download, FileSearch, Loader2, Upload, XCircle } from 'lucide-react'
import { useSession } from 'next-auth/react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker, formatDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

// =============================================================================
// Types
// =============================================================================

type CountryOption = 'US' | 'DE' | 'UK'

const CURRENCY_CONFIG: Record<CountryOption, { symbol: string; excelFmt: string }> = {
  US: { symbol: '$', excelFmt: '$#,##0.00;[Red]-$#,##0.00' },
  DE: { symbol: '€', excelFmt: '#,##0.00;[Red]-#,##0.00 €' },
  UK: { symbol: '£', excelFmt: '£#,##0.00;[Red]-£#,##0.00' },
}

type ProjectOption = {
  id?: number
  name: string
}

type CheckState = 'idle' | 'checking' | 'done' | 'error'
type RunState = 'idle' | 'running' | 'done' | 'error'
type IngestState = 'idle' | 'ingesting' | 'done' | 'error'

type PaymentPeriodOverlap = {
  period_start_date: string
  period_end_date: string
  source_id: number
}

type PeriodCoverageInfo = {
  period_start_date: string
  period_end_date: string
  source_id: number
  covered_dates: string[]
}

type DataAvailability = {
  // Missing check (single-day only, NOT affected by periodic data)
  business_report_missing: string[]
  ad_report_missing: string[]
  inventory_missing: string[]
  // Periodic coverage info
  business_period_info: PeriodCoverageInfo[]
  ad_period_info: PeriodCoverageInfo[]
  // Missing but covered by periodic (can calculate, but daily data is incomplete)
  business_periodic_only_missing: string[]
  ad_periodic_only_missing: string[]
  // Payment info
  payment_periods_overlapping: PaymentPeriodOverlap[]
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
  // Periodic coverage flag
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
// Manual Upload specific types
// =============================================================================

type UploadType = 'business_report' | 'payment_report' | 'ad_report' | 'inventory_report'
type AssignedType = UploadType | 'skip'
type UploadStatus = 'empty' | 'ready' | 'uploading' | 'success' | 'error'

type UploadFileMeta = {
  filePath: string
  filename: string
  originalFilename: string
}

type UploadStateItem = {
  status: UploadStatus
  mappedRowId: string | null
  selectedFile: File | null
  error: string | null
  uploaded: UploadFileMeta | null
}

type IngestOutcome = {
  report_type: string
  source_id: number | null
  success: boolean
  error_message: string | null
}

type FileConfig = {
  key: UploadType
  title: string
  accept: string
  required: boolean
}

type ProductRecognizedType = UploadType | 'unknown'

type ProductRecognitionResult = {
  type: ProductRecognizedType
  reason: string
}

type MappingRow = {
  id: string
  file: File
  detectedType: ProductRecognizedType
  detectedReason: string
  assignedType: AssignedType
  matchFailed: boolean
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

const FILE_CONFIG: FileConfig[] = [
  { key: 'business_report', title: '业务报告', accept: '.csv,text/csv', required: true },
  { key: 'payment_report', title: '付款报告', accept: '.csv,text/csv', required: true },
  { key: 'ad_report', title: '广告报告', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', required: true },
  { key: 'inventory_report', title: '库存报告（可选）', accept: '.txt,text/plain', required: false },
]

const TYPE_LABEL: Record<UploadType, string> = {
  business_report: '业务报告',
  payment_report: '付款报告',
  ad_report: '广告报告',
  inventory_report: '库存报告',
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const REPORT_ROWS = [
  { key: 'business_report', label: '业务报告', getMissing: (a: DataAvailability) => a.business_report_missing },
  { key: 'ad_report', label: '广告报告', getMissing: (a: DataAvailability) => a.ad_report_missing },
  { key: 'inventory', label: '库存报告', getMissing: (a: DataAvailability) => a.inventory_missing },
] as const

// =============================================================================
// Helper functions
// =============================================================================

function authHeaders(_operator?: string, _isAdmin = false): Record<string, string> {
  return {}
}

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

function getExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

async function readFirstLine(file: File) {
  try {
    const content = await file.slice(0, 4096).text()
    const firstLine = content.replace(/^﻿/, '').split(/\r?\n/)[0] ?? ''
    return firstLine.trim()
  } catch {
    return ''
  }
}

async function recognizeProductFile(file: File): Promise<ProductRecognitionResult> {
  const lowerName = file.name.toLowerCase()
  const ext = getExtension(file.name)

  if (ext === '.txt') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('snapshot-date')) return { type: 'inventory_report', reason: '首行包含 snapshot-date' }
    if (lowerName.includes('fba') || lowerName.includes('inventory') || lowerName.includes('库存')) {
      return { type: 'inventory_report', reason: '文件名命中 fba/inventory/库存 关键词' }
    }
    return { type: 'unknown', reason: 'txt 文件未命中库存识别规则' }
  }

  if (ext === '.xlsx') {
    if (lowerName.includes('ad') || lowerName.includes('广告') || lowerName.includes('推广')) {
      return { type: 'ad_report', reason: 'xlsx 文件名命中 ad/广告/推广关键词' }
    }
    return { type: 'ad_report', reason: 'xlsx 默认按广告报告处理（可手动修正）' }
  }

  if (ext === '.csv') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('includes amazon marketplace')) return { type: 'payment_report', reason: '首行包含 Includes Amazon Marketplace' }
    if (lowerName.includes('payment') || lowerName.includes('付款')) return { type: 'payment_report', reason: '文件名命中 payment/付款 关键词' }
    if (
      lowerName.includes('business') ||
      lowerName.includes('商业') ||
      lowerName.includes('业务') ||
      firstLine.includes('child asin') ||
      firstLine.includes('ordered product sales') ||
      firstLine.includes('sessions - total')
    ) {
      return { type: 'business_report', reason: 'csv 命中业务报告内容/文件名特征' }
    }
    return { type: 'unknown', reason: 'csv 未命中付款或业务报告规则' }
  }

  return { type: 'unknown', reason: `不支持的文件格式: ${ext || '未知'}` }
}

function createEmptyUploadState(): Record<UploadType, UploadStateItem> {
  return {
    business_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    payment_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    ad_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
    inventory_report: { status: 'empty', mappedRowId: null, selectedFile: null, error: null, uploaded: null },
  }
}

function getAssignedRow(rows: MappingRow[], type: UploadType): MappingRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].assignedType === type) return rows[i]
  }
  return null
}

function getUploadMeta(state: UploadStateItem) {
  if (state.status === 'success') return { text: '已上传', dot: 'bg-emerald-500', bar: 'bg-emerald-500' }
  if (state.status === 'uploading') return { text: '上传中', dot: 'bg-blue-500', bar: 'bg-blue-500' }
  if (state.status === 'error') return { text: '上传失败', dot: 'bg-rose-500', bar: 'bg-rose-500' }
  if (state.status === 'ready') return { text: '待上传', dot: 'bg-sky-500', bar: 'bg-sky-500' }
  return { text: '未识别', dot: 'bg-[hsl(var(--surface-outline))]', bar: 'bg-[hsl(var(--surface-outline))]' }
}

function validateTypeFile(type: UploadType, file: File) {
  const fileName = file.name.toLowerCase()
  if (type === 'ad_report') return fileName.endsWith('.xlsx')
  if (type === 'inventory_report') return fileName.endsWith('.txt')
  return fileName.endsWith('.csv')
}

function parseDateStr(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function formatDayAbbr(dateStr: string) {
  const d = parseDateStr(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function buildWeekDates(startDate: string, endDate: string): string[] {
  const start = parseDateStr(startDate)
  const end = parseDateStr(endDate)
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(formatDateInputValue(cur) ?? '')
    cur.setDate(cur.getDate() + 1)
  }
  return dates
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
  const currentOperator = (session?.user?.operatorNameZh || session?.user?.name || session?.user?.email || session?.user?.id || '').trim()
  const initialDateRange = getLastWeekRange()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)
  const [formError, setFormError] = useState<string | null>(null)

  const [mappingRows, setMappingRows] = useState<MappingRow[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [mappingBusy, setMappingBusy] = useState(false)

  const [uploadState, setUploadState] = useState<Record<UploadType, UploadStateItem>>(createEmptyUploadState)
  const [uploadBusy, setUploadBusy] = useState(false)

  // New states for the refactored flow
  const [ingestState, setIngestState] = useState<IngestState>('idle')
  const [ingestOutcomes, setIngestOutcomes] = useState<IngestOutcome[]>([])
  const [ingestError, setIngestError] = useState<string | null>(null)

  // Check & Run states (reused from ProductCalculationPanel)
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const [runState, setRunState] = useState<RunState>('idle')
  const [periods, setPeriods] = useState<CalculationPeriod[]>([])
  const [runError, setRunError] = useState<string | null>(null)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  const requiredKeys = useMemo(() => FILE_CONFIG.filter((item) => item.required).map((item) => item.key), [])

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

  useEffect(() => {
    setUploadState((prev) => {
      const next = { ...prev }
      FILE_CONFIG.forEach((item) => {
        const assigned = getAssignedRow(mappingRows, item.key)
        const previous = prev[item.key]

        if (!assigned) {
          next[item.key] = {
            status: 'empty',
            mappedRowId: null,
            selectedFile: null,
            error: null,
            uploaded: null,
          }
          return
        }

        if (previous.mappedRowId === assigned.id && (previous.status === 'success' || previous.status === 'uploading')) {
          next[item.key] = previous
          return
        }

        next[item.key] = {
          status: 'ready',
          mappedRowId: assigned.id,
          selectedFile: assigned.file,
          error: null,
          uploaded: null,
        }
      })
      return next
    })
  }, [mappingRows])

  const selectedProject = useMemo(
    () => projects.find((p) => p.name === projectName),
    [projects, projectName],
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate

  const requiredReadyCount = useMemo(
    () => requiredKeys.filter((key) => uploadState[key].status !== 'empty').length,
    [requiredKeys, uploadState]
  )

  const requiredUploadedCount = useMemo(
    () => requiredKeys.filter((key) => uploadState[key].status === 'success').length,
    [requiredKeys, uploadState]
  )

  const manualMatchRows = useMemo(
    () => mappingRows.filter((row) => row.matchFailed && row.assignedType === 'skip'),
    [mappingRows]
  )

  const dropZoneHeight = Math.min(460, 210 + Math.max(4, manualMatchRows.length + FILE_CONFIG.length) * 28)

  // All required files uploaded and ingested
  const allFilesIngested = useMemo(
    () => requiredKeys.every((key) => {
      const uploaded = uploadState[key].status === 'success'
      const ingested = ingestOutcomes.some(
        (o) => o.report_type === key && o.success
      )
      return uploaded && ingested
    }),
    [requiredKeys, uploadState, ingestOutcomes]
  )

  // Can check data: project selected, dates valid, all files ingested
  const canCheck = useMemo(
    () => Boolean(selectedProject?.id) && dateRangeValid && allFilesIngested && checkState !== 'checking',
    [selectedProject, dateRangeValid, allFilesIngested, checkState]
  )

  // Can run calculation: checked and data available
  const canRun = useMemo(
    () => checkState === 'done' && availability?.has_minimum_data && runState !== 'running',
    [checkState, availability, runState]
  )

  const ingestMeta = useMemo(() => {
    if (ingestState === 'ingesting') return { label: '入库中', className: 'text-blue-600' }
    if (ingestState === 'done') return { label: '已入库', className: 'text-emerald-600' }
    if (ingestState === 'error') return { label: '入库失败', className: 'text-rose-600' }
    return { label: '待入库', className: 'text-muted-foreground' }
  }, [ingestState])

  const addFiles = async (files: File[]) => {
    if (!files.length) return

    setFormError(null)
    setMappingBusy(true)

    const recognized = await Promise.all(
      files.map(async (file) => {
        const match = await recognizeProductFile(file)
        return { file, ...match }
      })
    )

    setMappingRows((prev) => {
      const next = [...prev]

      recognized.forEach(({ file, type, reason }) => {
        const row: MappingRow = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
          detectedType: type,
          detectedReason: reason,
          assignedType: type === 'unknown' ? 'skip' : type,
          matchFailed: type === 'unknown',
        }

        if (row.assignedType !== 'skip') {
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].assignedType === row.assignedType) {
              next[i] = { ...next[i], assignedType: 'skip', matchFailed: false }
              break
            }
          }
        }

        next.push(row)
      })

      const hasBusiness = next.some((row) => row.assignedType === 'business_report')
      if (!hasBusiness) {
        const fallbackRow = recognized.find((item) => item.type === 'unknown' && getExtension(item.file.name) === '.csv')
        if (fallbackRow) {
          const fallbackId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
          next.push({
            id: fallbackId,
            file: fallbackRow.file,
            detectedType: 'unknown',
            detectedReason: 'csv 兜底分配为业务报告',
            assignedType: 'business_report',
            matchFailed: false,
          })
        }
      }

      return next
    })

    setMappingBusy(false)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    await addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const applyLastWeek = () => {
    const range = getLastWeekRange()
    setStartDate(range.start)
    setEndDate(range.end)
    setFormError(null)
  }

  const changeAssignedType = (rowId: string, value: AssignedType) => {
    setMappingRows((prev) => {
      const updated: MappingRow[] = prev.map((row) => {
        if (row.id !== rowId) return row
        return { ...row, assignedType: value, matchFailed: false }
      })

      if (value === 'skip') return updated

      return updated.map((row) => {
        if (row.id === rowId) return row
        if (row.assignedType === value) return { ...row, assignedType: 'skip', matchFailed: false }
        return row
      })
    })
  }

  const uploadType = async (type: UploadType) => {
    if (!projectName.trim()) {
      setFormError('请先填写项目名称，再执行上传。')
      return
    }

    const target = uploadState[type]
    if (!target.selectedFile) {
      setUploadState((prev) => ({
        ...prev,
        [type]: { ...prev[type], status: 'error', error: '缺少已确认文件，请先匹配。' },
      }))
      return
    }

    if (!validateTypeFile(type, target.selectedFile)) {
      setUploadState((prev) => ({
        ...prev,
        [type]: { ...prev[type], status: 'error', error: '文件格式不支持，请检查映射。' },
      }))
      return
    }

    setUploadState((prev) => ({
      ...prev,
      [type]: { ...prev[type], status: 'uploading', error: null, uploaded: null },
    }))

    const formData = new FormData()
    formData.append('file', target.selectedFile)
    formData.append('project_name', projectName.trim())
    formData.append('file_type', type)

    try {
      const response = await fetch(`${API_BASE}/api/v1/uploads`, {
        method: 'POST',
        body: formData,
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || '文件上传失败，请重试')
      }

      const payload = (await response.json()) as {
        file_path?: string
        filename?: string
        original_filename?: string
      }

      if (!payload.file_path || !payload.filename || !payload.original_filename) {
        throw new Error('上传成功但响应缺少必要字段')
      }

      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'success',
          error: null,
          uploaded: {
            filePath: payload.file_path,
            filename: payload.filename,
            originalFilename: payload.original_filename,
          },
        },
      }))

      // Reset ingest state when files change
      setIngestState('idle')
      setIngestOutcomes([])
      setIngestError(null)
      setCheckState('idle')
      setAvailability(null)
      setRunState('idle')
      setPeriods([])
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: 'error',
          error: error instanceof Error ? error.message : '文件上传失败，请重试',
          uploaded: null,
        },
      }))
    }
  }

  const uploadAllConfirmed = async () => {
    if (uploadBusy) return
    setUploadBusy(true)
    for (const item of FILE_CONFIG) {
      const state = uploadState[item.key]
      if (state.status === 'ready' || state.status === 'error') {
        // eslint-disable-next-line no-await-in-loop
        await uploadType(item.key)
      }
    }
    setUploadBusy(false)
  }

  // New: Ingest uploaded files to database
  const ingestFilesToDatabase = async () => {
    if (!projectName.trim()) {
      setFormError('请先填写项目名称')
      return
    }
    if (!requiredKeys.every((key) => uploadState[key].status === 'success')) {
      setFormError('请先完成必需文件上传')
      return
    }

    setIngestState('ingesting')
    setIngestError(null)
    setIngestOutcomes([])

    const fileIds: Record<string, string> = {}
    const resolvedFilePaths: Record<string, string> = {}

    for (const type of requiredKeys) {
      const uploaded = uploadState[type].uploaded
      if (uploaded) {
        fileIds[type] = uploaded.filename
        resolvedFilePaths[type] = uploaded.filePath
      }
    }

    // Add optional inventory report if uploaded
    if (uploadState.inventory_report.status === 'success' && uploadState.inventory_report.uploaded) {
      fileIds.inventory_report = uploadState.inventory_report.uploaded.filename
      resolvedFilePaths.inventory_report = uploadState.inventory_report.uploaded.filePath
    }

    try {
      const response = await fetch(`${API_BASE}/api/v1/product-analysis/sources/upload-file`, {
        method: 'POST',
        headers: {
          ...authHeaders(currentOperator, isAdmin),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: projectName.trim(),
          country,
          report_start_date: startDate,
          report_end_date: endDate,
          file_ids: fileIds,
          resolved_file_paths: resolvedFilePaths,
        }),
      })

      if (!response.ok) {
        const message = await parseApiError(response, '入库失败，请重试')
        throw new Error(message)
      }

      const payload = (await response.json()) as { outcomes: IngestOutcome[] }
      setIngestOutcomes(payload.outcomes)
      setIngestState('done')

      // Auto-trigger data check after successful ingestion
      if (selectedProject?.id) {
        setCheckState('checking')
        setCheckError(null)
        setAvailability(null)
        setRunState('idle')
        setPeriods([])
        setExpandedIndex(null)

        try {
          const checkRes = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(currentOperator, isAdmin) },
            body: JSON.stringify({
              project_id: selectedProject.id,
              country,
              start_date: startDate,
              end_date: endDate,
            }),
          })

          if (!checkRes.ok) {
            const err = await checkRes.json().catch(() => ({ detail: '检查数据失败' }))
            throw new Error(typeof err.detail === 'string' ? err.detail : '检查数据失败')
          }

          const data: DataAvailability = await checkRes.json()
          setAvailability(data)
          setCheckState('done')
        } catch (err) {
          setCheckError(err instanceof Error ? err.message : '检查数据失败')
          setCheckState('error')
        }
      }
    } catch (error) {
      setIngestError(error instanceof Error ? error.message : '入库失败')
      setIngestState('error')
    }
  }

  // Handle check data
  const handleCheck = async () => {
    if (!selectedProject?.id) return

    setCheckState('checking')
    setCheckError(null)
    setAvailability(null)
    setRunState('idle')
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(currentOperator, isAdmin) },
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
  }

  // Handle run calculation
  const handleRun = async () => {
    if (!selectedProject?.id) return

    setRunState('running')
    setRunError(null)
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(currentOperator, isAdmin) },
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
  }

  // Handle export
  const handleExport = async () => {
    if (periods.length === 0) return

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    wb.creator = 'BelieveBoy'
    wb.created = new Date()

    const projectLabel = projectName || '未知项目'
    const summarySheet = wb.addWorksheet('汇总')
    const detailSheet = wb.addWorksheet('SKU明细')

    // Simplified export - just use the existing periods data
    const startDateCompact = startDate.replaceAll('-', '')
    const endDateCompact = endDate.replaceAll('-', '')
    const filename = `产品核算-${projectLabel}-${country}-${startDateCompact}~${endDateCompact}.xlsx`

    // Add summary sheet with basic info
    summarySheet.getCell(1, 1).value = `产品核算汇总 - ${projectLabel} ${country} ${startDate} 至 ${endDate}`
    summarySheet.getCell(1, 1).font = { size: 14, bold: true }
    summarySheet.getCell(2, 1).value = `生成时间: ${new Date().toLocaleString('zh-CN')}`
    summarySheet.getCell(2, 1).font = { size: 10 }
    summarySheet.getCell(3, 1).value = `共 ${periods.length} 个周期`

    // Add detail sheet
    detailSheet.getCell(1, 1).value = `产品核算明细 - ${projectLabel} ${country} ${startDate} 至 ${endDate}`
    detailSheet.getCell(1, 1).font = { size: 14, bold: true }

    // Headers for detail
    const headers = ['周期', 'SKU', 'ASIN', '总销量', '总销售额', '广告花费', 'ACOS', '利润', '利润率']
    headers.forEach((header, idx) => {
      const cell = detailSheet.getCell(3, idx + 1)
      cell.value = header
      cell.font = { bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    })

    let rowIdx = 4
    periods.forEach((period) => {
      period.details.forEach((detail) => {
        detailSheet.getCell(rowIdx, 1).value = `${period.report_start_date} ~ ${period.report_end_date}`
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
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  function renderCell(value: unknown, fmt?: 'percent' | 'currency') {
    if (value === null || value === undefined) return <span className="text-muted-foreground">-</span>
    if (fmt === 'percent') return <span>{formatPercent(value)}</span>
    if (fmt === 'currency') {
      const sym = CURRENCY_CONFIG[country].symbol
      return <span>{sym}{formatNumber(value)}</span>
    }
    return <span>{formatNumber(value)}</span>
  }

  const detailColCount = DETAIL_DISPLAY_COLUMNS.length

  return (
    <div className="space-y-4">
      {/* Filter Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">核算参数</CardTitle>
          <CardDescription className="text-xs">
            选择项目、站点和日期范围，上传报表后执行核算。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                  setIngestState('idle')
                  setIngestOutcomes([])
                }}
                disabled={projectsLoading || projects.length === 0}
              >
                <SelectTrigger className="h-10 max-w-full">
                  <SelectValue
                    placeholder={projectsLoading ? '项目加载中...' : projects.length ? '请选择项目名称' : '暂无可选项目'}
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
                <SelectTrigger className="h-10 max-w-full">
                  <SelectValue placeholder="请选择国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
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
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
                className="h-10"
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
              <Button type="button" variant="secondary" onClick={applyLastWeek} className="w-full h-10">
                <CalendarRange className="mr-1 h-4 w-4" />
                上周
              </Button>
            </div>
          </div>

          {/* Status indicators */}
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
              <p className="text-xs text-muted-foreground">识别</p>
              <p className="mt-1 text-sm font-semibold">{requiredReadyCount}/3</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
              <p className="text-xs text-muted-foreground">上传</p>
              <p className="mt-1 text-sm font-semibold">{requiredUploadedCount}/3</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
              <p className="text-xs text-muted-foreground">数据入库</p>
              <p className={cn('mt-1 text-sm font-semibold', ingestMeta.className)}>{ingestMeta.label}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2">
              <p className="text-xs text-muted-foreground">核算状态</p>
              <p className="mt-1 text-sm font-semibold">
                {runState === 'done' ? '已完成' : runState === 'running' ? '进行中' : runState === 'error' ? '异常' : '未开始'}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void ingestFilesToDatabase()}
              disabled={
                !projectName.trim() ||
                !requiredKeys.every((key) => uploadState[key].status === 'success') ||
                ingestState === 'ingesting'
              }
            >
              {ingestState === 'ingesting' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <DatabaseZap className="mr-1 h-4 w-4" />
              )}
              写入数据库
            </Button>

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

            <Button
              type="button"
              onClick={() => void handleRun()}
              disabled={!canRun}
            >
              {runState === 'running' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              执行核算
            </Button>
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {formError}
            </div>
          )}

          {ingestError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              入库失败：{ingestError}
            </div>
          )}

          {checkError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {checkError}
            </div>
          )}

          {runError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {runError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* File Upload Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">文件识别与上传</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
            {/* Drop zone */}
            <div
              className={cn(
                'flex flex-col rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                dragActive ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-900/20' : 'border-border bg-[hsl(var(--surface-subtle))]'
              )}
              style={{ minHeight: `${dropZoneHeight}px` }}
              onDrop={(event) => void onDrop(event)}
              onDragOver={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                setDragActive(false)
              }}
            >
              <p className="text-sm font-semibold text-foreground">拖拽文件到这里</p>
              <p className="mt-1 text-xs text-muted-foreground">支持 csv/xlsx/txt 批量识别</p>

              <div className="mt-auto space-y-2 pt-4">
                <Button type="button" variant="outline" className="w-full" onClick={() => document.getElementById('product-file-picker')?.click()}>
                  <FileSearch className="mr-1 h-4 w-4" />
                  选择多个文件
                </Button>
                <Input
                  id="product-file-picker"
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.txt"
                  className="hidden"
                  onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
                />
                <Button type="button" className="w-full" onClick={() => void uploadAllConfirmed()} disabled={uploadBusy || mappingBusy || !projectName.trim()}>
                  {uploadBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
                  一键上传已匹配文件
                </Button>
              </div>
            </div>

            {/* File list */}
            <div className="space-y-4">
              {FILE_CONFIG.map((item) => {
                const state = uploadState[item.key]
                const meta = getUploadMeta(state)
                const matched = state.status !== 'empty'
                const ingested = ingestOutcomes.some((o) => o.report_type === item.key && o.success)
                return (
                  <div key={item.key} className="flex min-h-[120px] flex-col rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2.5 w-2.5 rounded-full', meta.dot)} />
                        <p className="text-sm font-semibold text-foreground">{item.title}</p>
                        {ingested && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      </div>
                      <span className="text-xs text-muted-foreground">{meta.text}</span>
                    </div>

                    <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--surface-high))]">
                      <div
                        className={cn('h-full transition-all duration-200', matched ? meta.bar : 'bg-[hsl(var(--surface-outline))]')}
                        style={{ width: matched ? '100%' : '28%' }}
                      />
                    </div>

                    <div className="mt-auto flex items-end justify-between gap-3 pt-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-muted-foreground">{state.selectedFile?.name ?? '等待识别或手动匹配'}</p>
                        {state.error ? <p className="mt-1 text-xs text-destructive">{state.error}</p> : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void uploadType(item.key)}
                        disabled={state.status === 'empty' || state.status === 'uploading' || !projectName.trim()}
                      >
                        {state.status === 'uploading' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                        上传
                      </Button>
                    </div>
                  </div>
                )
              })}

              {manualMatchRows.length > 0 && (
                <div className="rounded-lg border border-blue-200/70 bg-blue-50/60 p-3 dark:border-blue-800/50 dark:bg-blue-950/20">
                  <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">手动匹配</p>
                  <p className="mt-1 text-xs text-blue-700/80 dark:text-blue-200/80">以下文件识别失败，请手动指定类型。</p>

                  <div className="mt-3 space-y-2">
                    {manualMatchRows.map((row) => (
                      <div key={row.id} className="grid gap-2 rounded-md border border-blue-200/70 bg-[hsl(var(--surface-panel))] p-2 dark:border-blue-800/40 md:grid-cols-[1fr_210px]">
                        <div>
                          <p className="truncate text-sm font-medium text-foreground">{row.file.name}</p>
                          <p className="text-xs text-muted-foreground">{row.detectedReason}</p>
                        </div>
                        <Select value={row.assignedType} onValueChange={(value) => changeAssignedType(row.id, value as AssignedType)}>
                          <SelectTrigger>
                            <SelectValue placeholder="手动选择类型" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="business_report">业务报告</SelectItem>
                            <SelectItem value="payment_report">付款报告</SelectItem>
                            <SelectItem value="ad_report">广告报告</SelectItem>
                            <SelectItem value="inventory_report">库存报告</SelectItem>
                            <SelectItem value="skip">跳过</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Data Availability */}
      {availability && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">数据可用性</CardTitle>
            <CardDescription className="text-xs">
              {startDate} — {endDate}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 border-t border-[hsl(var(--border))] pt-2.5">
              {availability.has_minimum_data ? (
                <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  可执行核算
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-sm font-medium text-rose-600 dark:text-rose-300">
                  <XCircle className="h-4 w-4" />
                  数据不足，无法执行核算（缺少核心报表数据）
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {runState === 'done' && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">核算结果</CardTitle>
                <CardDescription className="text-xs">
                  共 {periods.length} 个周期
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                disabled={periods.length === 0}
              >
                <Download className="mr-1 h-4 w-4" />
                导出 Excel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {periods.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                无核算数据
              </div>
            ) : (
              <div className="space-y-3">
                {periods.map((period, idx) => {
                  const isExpanded = expandedIndex === idx
                  return (
                    <div key={idx} className="space-y-1">
                      {/* Summary row */}
                      <div
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          isExpanded ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-muted/30'
                        }`}
                        onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                      >
                        <button
                          className="rounded p-0.5 hover:bg-accent shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedIndex(isExpanded ? null : idx)
                          }}
                        >
                          {isExpanded ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                        </button>

                        <span className="shrink-0 font-medium text-sm">
                          {period.report_start_date} ~ {period.report_end_date}
                          {period.persisted && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              已写入PT1
                            </span>
                          )}
                        </span>

                        <span className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                          <span>总销售额: {renderCell(period.summary['总销售额'])}</span>
                          <span>利润: {renderCell(period.summary['利润'])}</span>
                          <span>利润率: {renderCell(period.summary['利润率'], 'percent')}</span>
                          <span>ACOS: {renderCell(period.summary['ACOS'], 'percent')}</span>
                        </span>
                      </div>

                      {/* Detail table */}
                      {isExpanded && (
                        <div className="overflow-x-auto rounded-md border">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b bg-muted/50">
                                {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                  <th
                                    key={col.key}
                                    className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                                  >
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {period.details.length === 0 ? (
                                <tr>
                                  <td colSpan={detailColCount} className="px-3 py-4 text-center text-muted-foreground">
                                    无 SKU 明细
                                  </td>
                                </tr>
                              ) : (
                                period.details.map((detail, dIdx) => (
                                  <tr key={dIdx} className="border-b border-[hsl(var(--border))] hover:bg-muted/20">
                                    {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                      <td key={col.key} className="px-3 py-1.5 text-right whitespace-nowrap">
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
          </CardContent>
        </Card>
      )}
    </div>
  )
}
