'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleX,
  LayoutDashboard,
  Loader2,
  Upload,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  formatDateInputValue,
  parseDateInputValue,
  SimpleDatePicker,
} from '@/components/ui/date-picker'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import {
  AD_REPORT_TYPES,
  REPORT_UPLOAD_COUNTRY_OPTIONS,
  getReportUploadCountryLabel,
  isDateRequired,
  type ReportType,
  type UploadQueueItem,
  type RecognitionResponse,
  type ReportUploadCountry,
} from '@/components/report-upload/types'

const API_BASE = '/api/backend'

// ── Shared constants ─────────────────────────────────────────────────────────

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站' },
  { value: 'DE', label: '德国站' },
  { value: 'UK', label: '英国站' },
]

const REPORT_UPLOAD_REPORT_TYPE_LABELS: Record<string, string> = {
  inventory_report: '亚马逊物流库存',
  business_report: '业务报告',
  ad_product_report: '广告 - 已推广商品',
  sales_report: '销售报表 - 所有订单',
  payment_report: '付款报告',
  return_report: '退货报告',
  ...AD_REPORT_TYPES.reduce<Record<string, string>>((acc, item) => {
    acc[item.type] = `广告 - ${item.label}`
    return acc
  }, {}),
}

function getUploadReportTypeLabel(type: UploadQueueItem['reportType']): string {
  if (!type || type === 'unknown') return '未识别'
  return REPORT_UPLOAD_REPORT_TYPE_LABELS[type] ?? type
}

function getMultiCountryDisplay(countries: string[]): string {
  if (!countries || countries.length === 0) return '未识别'
  if (countries.length === 1) {
    return getReportUploadCountryLabel(countries[0], true)
  }
  return countries.map(c => getReportUploadCountryLabel(c, true)).join(' + ')
}

// ── RPA Status types ──────────────────────────────────────────────────────────

function getTodayLocal(): Date {
  return new Date()
}

function toLocalDateInputValue(input?: Date): string {
  const date = input ?? getTodayLocal()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDateString(value: string, offsetDays: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year!, (month! || 1) - 1, day! || 1)
  date.setDate(date.getDate() + offsetDays)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

type StatusCell = {
  report_type: string
  has_data: boolean
  is_uploaded: boolean
  latest_date: string | null
  original_filename: string | null
}

type ProjectRow = {
  project_id: number
  project_name: string
  country: string
  statuses: StatusCell[]
}

const REPORT_TYPES = [
  { key: 'inventory_report', label: '库存', active: true },
  { key: 'business_report', label: '业务', active: true },
  { key: 'sales_report', label: '销售', active: true },
  { key: 'payment_report', label: '付款', active: true },
  { key: 'return_report', label: '退货', active: true },
  ...AD_REPORT_TYPES.map((item) => ({
    key: item.type,
    label: item.short,
    active: true,
  })),
  { key: 'storage_report', label: '仓储', active: false },
  { key: 'returns_detail_report', label: '退货明细', active: false },
  { key: 'fba_inventory_report', label: 'FBA库存', active: false },
  { key: 'reimbursement_report', label: '赔偿', active: false },
  { key: 'tax_invoice_report', label: '税务发票', active: false },
  { key: 'health_report', label: '健康报告', active: false },
  { key: 'advertising_reports', label: '广告报表', active: false },
  { key: 'brand_report', label: '品牌报表', active: false },
  { key: 'vendor_report', label: '供应商', active: false },
]

const TABLE_HEADER_HEIGHT_CLASS = 'h-[clamp(3.5rem,3.8vh,4.25rem)] min-h-14 max-h-[4.25rem]'
const TABLE_ROW_HEIGHT_CLASS = 'h-[clamp(2.8rem,3.2vh,3.5rem)] min-h-[2.8rem] max-h-[3.5rem]'

// ── RPA Status Grid ──────────────────────────────────────────────────────────

function RpaStatusGrid({ country, onCountryChange }: { country: string; onCountryChange: (v: string) => void }) {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])

  const [statusRows, setStatusRows] = useState<ProjectRow[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const { showSkeleton, isRefreshing } = useSmoothRefresh({ loading: statusLoading, hasData: statusRows.length > 0 })

  const [statusDate, setStatusDate] = useState(() => toLocalDateInputValue())

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<Array<{ name: string }>>(session)
        setProjects(payload.map((item) => item.name).filter(Boolean))
      } catch (_error) {
        // ignore
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  const loadStatus = async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const query = new URLSearchParams({ report_date: statusDate, country })
      const response = await fetch(
        `${API_BASE}/api/v1/rpa-reports/status?${query.toString()}`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const payload = (await response.json()) as { items: ProjectRow[] }
      setStatusRows(payload.items || [])
    } catch (error) {
      setStatusError(normalizeErrorMessage(error, '报表状态加载失败'))
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [statusDate, country]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredRows = useMemo(() => {
    if (selectedProjects.length === 0) return statusRows
    return statusRows.filter((row) => selectedProjects.includes(row.project_name))
  }, [selectedProjects, statusRows])

  const projectFilterLabel = useMemo(() => {
    if (selectedProjects.length === 0) return '全部项目'
    if (selectedProjects.length === 1) return selectedProjects[0]
    return `已选 ${selectedProjects.length} 个项目`
  }, [selectedProjects])

  return (
    <Card className='flex flex-1 flex-col overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
      <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3 sm:px-6 sm:py-4 shrink-0'>
        <div className='flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-9 w-9 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground sm:h-10 sm:w-10'>
              <LayoutDashboard className='h-4 w-4 sm:h-5 sm:w-5' />
            </div>
            <CardTitle className='self-center text-base sm:text-lg'>RPA 报表状态</CardTitle>
          </div>

          {/* Mobile: 2-column grid; lg+: horizontal row */}
          <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-row lg:flex-wrap lg:items-center lg:gap-2'>
            {/* Row 1: 项目 + 站点 */}
            <div className='contents lg:flex lg:items-center lg:gap-2'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-9 w-full justify-start border-border/70 bg-background text-left font-normal dark:bg-[hsl(var(--surface-soft))] sm:h-10'
                  >
                    {projectFilterLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-[280px]'>
                  <DropdownMenuLabel>项目筛选</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <button
                    type='button'
                    className='w-full rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground'
                    onClick={() => setSelectedProjects([])}
                  >
                    全部项目
                  </button>
                  <DropdownMenuSeparator />
                  {projects.map((project) => (
                    <DropdownMenuCheckboxItem
                      key={project}
                      checked={selectedProjects.includes(project)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) => {
                        setSelectedProjects((prev) => {
                          if (checked) {
                            return prev.includes(project) ? prev : [...prev, project]
                          }
                          return prev.filter((p) => p !== project)
                        })
                      }}
                    >
                      {project}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Select value={country} onValueChange={onCountryChange}>
                <SelectTrigger className='h-9 w-full rounded-md border-border/70 bg-background dark:bg-[hsl(var(--surface-soft))] sm:h-10 sm:w-[140px]'>
                  <SelectValue placeholder='选择站点' />
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

            {/* Row 2: 日期导航 */}
            <div className='contents lg:flex lg:items-center lg:gap-1'>
              <Button
                type='button'
                variant='outline'
                size='icon'
                className='h-9 w-9 shrink-0 sm:h-10 sm:w-10'
                onClick={() => setStatusDate((v) => shiftDateString(v, -1))}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <SimpleDatePicker
                value={parseDateInputValue(statusDate)}
                onChange={(date) => setStatusDate(formatDateInputValue(date))}
                className='h-9 w-full sm:h-10 sm:w-[170px] bg-background dark:bg-[hsl(var(--surface-soft))]'
              />
              <Button
                type='button'
                variant='outline'
                size='icon'
                className='h-9 w-9 shrink-0 sm:h-10 sm:w-10'
                onClick={() => setStatusDate((v) => shiftDateString(v, 1))}
              >
                <ChevronRight className='h-4 w-4' />
              </Button>
            </div>

            {/* Row 3: 今天 + 刷新 */}
            <div className='contents lg:flex lg:items-center lg:gap-1'>
              <Button
                type='button'
                variant='secondary'
                size='sm'
                className='h-9 sm:h-10'
                onClick={() => setStatusDate(toLocalDateInputValue(undefined))}
              >
                今天
              </Button>

              <Button
                type='button'
                variant='outline'
                size='icon'
                className='h-9 w-9 shrink-0 sm:h-10 sm:w-10'
                onClick={() => void loadStatus()}
                disabled={statusLoading}
                title='刷新状态'
              >
                <Loader2 className={cn('h-4 w-4', statusLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>

      <div className='flex min-h-0 flex-1 flex-col p-0 relative'>
        {statusError ? (
          <p className='py-4 pl-6 text-sm text-rose-600'>{statusError}</p>
        ) : null}

        {showSkeleton ? (
          <div className='flex min-h-0 flex-1 flex-col space-y-3'>
            <Skeleton className='h-10 w-full rounded-none shrink-0' />
            <Skeleton className='flex-1 w-full rounded-none min-h-0' />
          </div>
        ) : (
          <RefreshProgressBar refreshing={isRefreshing} className='flex min-h-0 flex-1 flex-col overflow-auto'>
            <div
              className='grid min-w-max shrink-0'
              style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
            >
              <div
                className={`flex items-center border border-b-0 border-border/50 bg-[hsl(var(--surface-subtle))] px-3 ${TABLE_HEADER_HEIGHT_CLASS}`}
              >
                <span className='text-xs font-semibold uppercase tracking-widest text-muted-foreground'>项目</span>
              </div>
              {REPORT_TYPES.map((rt, colIdx) => (
                <div
                  key={rt.key}
                  className={`flex items-center justify-center border-b border-t border-border/50 px-1 ${TABLE_HEADER_HEIGHT_CLASS}${colIdx < REPORT_TYPES.length - 1 ? ' border-r' : ''}`}
                >
                  <span className={`text-xs font-semibold uppercase tracking-wider${rt.active ? ' text-muted-foreground' : ' text-muted-foreground/40'}`}>{rt.label}</span>
                </div>
              ))}
            </div>

            {filteredRows.length === 0 ? (
              <div className='flex flex-1 flex-col items-center justify-center py-16'>
                <p className='text-base font-medium'>
                  {statusDate} 暂时没有可展示的报表状态
                </p>
                <p className='mt-2 text-sm text-muted-foreground'>
                  切换左右日期，或检查 RPA 是否已接入该日期的数据
                </p>
              </div>
            ) : (
              <div className='flex min-h-0 flex-1 flex-col min-w-max'>
                {filteredRows.map((row) => (
                  <div
                    key={row.project_id}
                    className={`grid border border-t-0 border-border/50 transition-colors hover:bg-[hsl(var(--surface-subtle))] ${TABLE_ROW_HEIGHT_CLASS}`}
                    style={{ gridTemplateColumns: `160px repeat(${REPORT_TYPES.length}, 96px)` }}
                  >
                    <div className='flex items-center border-r border-border/50 bg-[hsl(var(--surface-panel))] px-3'>
                      <span className='truncate text-sm font-medium'>{row.project_name}</span>
                    </div>
                    {REPORT_TYPES.map((rt, colIdx) => {
                      const cell = row.statuses.find((s) => s.report_type === rt.key)
                      const isUploaded = cell?.is_uploaded ?? false
                      return (
                        <div
                          key={rt.key}
                          className={`flex items-center justify-center border-border/50 px-1 py-2.5${colIdx < REPORT_TYPES.length - 1 ? ' border-r' : ''}${
                            !rt.active
                              ? ''
                              : isUploaded
                                ? ' bg-emerald-600'
                                : ' bg-rose-500'
                          }`}
                        >
                          {isUploaded ? (
                            <CheckCircle2 className='h-4 w-4 text-white' />
                          ) : (
                            <CircleX className='h-4 w-4 text-white' />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </RefreshProgressBar>
        )}
      </div>
    </Card>
  )
}

// ── Auto Upload Content ──────────────────────────────────────────────────────

type UploadEndpoint = 'report-upload' | 'ad-upload'

function AutoUploadContent({
  country,
  onCountryChange,
  endpoint,
}: {
  country: ReportUploadCountry
  onCountryChange: (v: ReportUploadCountry) => void
  endpoint: UploadEndpoint
}) {
  const { data: session } = useSession()
  const [dragActive, setDragActive] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  const [recognitionMap, setRecognitionMap] = useState<Record<string, RecognitionResponse>>({})
  // 项目列表（用于手动选择）
  const [availableProjects, setAvailableProjects] = useState<string[]>([])

  // 加载项目列表
  useEffect(() => {
    const loadProjects = async () => {
      try {
        const payload = await fetchManagedProjectsCached<Array<{ name: string }>>(session)
        setAvailableProjects(payload.map((item) => item.name).filter(Boolean))
      } catch {
        // ignore
      }
    }
    void loadProjects()
  }, [session])

  const recognizeFiles = async (files: File[]) => {
    if (!files.length) return

    const pending: UploadQueueItem[] = files.map((file) => ({
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

    setQueueItems((prev) => [...pending, ...prev])
    setRecognizing(true)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const item = pending[i]
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('country', country)
        const res = await fetch(`${API_BASE}/api/v1/${endpoint}/recognize`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || '识别失败')
        }
        const recognition: RecognitionResponse = await res.json()

         setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  tempFileId: recognition.temp_file_id,
                  reportType: recognition.report_type as UploadQueueItem['reportType'],
                  recognitionStatus: recognition.status,
                  recognizedProject:
                    recognition.project_match.status === 'matched'
                      ? recognition.project_match.project_name ?? null
                      : recognition.project_match.status === 'conflict'
                        ? `候选 ${recognition.project_match.candidate_projects.length} 个`
                        : '未匹配',
                  detectedDate:
                    recognition.detected_date ??
                    recognition.detected_end_date ??
                    null,
                  detectedStartDate: recognition.detected_start_date ?? null,
                  detectedEndDate: recognition.detected_end_date ?? null,
                  detectedCountry: recognition.country,
                  detectedCountries: recognition.detected_countries ?? [],
                  isMultiCountry: (recognition.detected_countries?.length ?? 0) > 1,
                  error:
                    recognition.status === 'recognized'
                      ? null
                      : recognition.reason,
                }
              : it,
          ),
        )
        setRecognitionMap((prev) => ({ ...prev, [item.localId]: recognition }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : '识别失败'
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  reportType: 'unknown',
                  recognitionStatus: 'error',
                  recognizedProject: null,
                  userSelectedProject: null,
                  fileCommitStatus: 'error',
                  error: msg,
                }
              : it,
          ),
        )
      }
    }

    setRecognizing(false)
  }

  const handleUploadAll = async () => {
    setUploading(true)

    for (const item of queueItems) {
      if (
        item.recognitionStatus !== 'recognized' ||
        !item.tempFileId ||
        !item.reportType ||
        item.reportType === 'unknown' ||
        item.fileCommitStatus === 'success'
      ) {
        continue
      }

      const recognition = recognitionMap[item.localId]
      if (!recognition) continue

      // Multi-country detection: sales reports with multiple countries are auto-split
      const isMultiCountrySalesReport =
        item.reportType === 'sales_report' &&
        recognition.detected_countries &&
        recognition.detected_countries.length > 1

      // Validate country only for single-country files
      if (!isMultiCountrySalesReport && recognition.country && recognition.country !== country) {
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  fileCommitStatus: 'error',
                  commitError: `文件站点（${recognition.country}）与所选站点（${country}）不一致，请上传到对应站点`,
                }
              : it,
          ),
        )
        continue
      }

      // 检查项目匹配状态
      const autoMatchedProject = recognition.project_match.status === 'matched'
        ? recognition.project_match.project_name ?? null
        : null
      const finalProjectName = item.userSelectedProject ?? autoMatchedProject

      // 如果项目未匹配且用户未手动选择，报错
      if (!finalProjectName) {
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? {
                  ...it,
                  fileCommitStatus: 'error',
                  commitError: '请先选择项目',
                }
              : it,
          ),
        )
        continue
      }

       // Check if date is required but missing
      const resolvedDate = item.userReportDate ?? recognition.detected_date ?? recognition.detected_end_date ?? null
      const resolvedStartDate = item.userReportStartDate ?? recognition.detected_start_date ?? null
      const resolvedEndDate = item.userReportEndDate ?? recognition.detected_end_date ?? null
      if (isDateRequired(item.reportType)) {
        if (item.reportType === 'payment_report') {
          if (!resolvedStartDate || !resolvedEndDate) {
            setQueueItems((prev) =>
              prev.map((it) =>
                it.localId === item.localId
                  ? {
                      ...it,
                      fileCommitStatus: 'error',
                      commitError: '请填写完整的日期范围',
                    }
                  : it,
              ),
            )
            continue
          }
        } else if (!resolvedDate) {
          setQueueItems((prev) =>
            prev.map((it) =>
              it.localId === item.localId
                ? {
                    ...it,
                    fileCommitStatus: 'error',
                    commitError: '请填写报表日期',
                  }
                : it,
            ),
          )
          continue
        }
      }

      setQueueItems((prev) =>
        prev.map((it) =>
          it.localId === item.localId
            ? { ...it, fileCommitStatus: 'saving', commitError: null }
            : it,
        ),
      )

       try {
        const resolvedStartDate = item.userReportStartDate ?? recognition.detected_start_date ?? null
        const resolvedEndDate = item.userReportEndDate ?? recognition.detected_end_date ?? null

        // 多站点文件：传入 primary_country 供后端参考（后端会按检测到的所有国家拆分）
        const effectiveCountry = isMultiCountrySalesReport
          ? (recognition.primary_country ?? country)
          : country

        const payload = {
          temp_file_id: item.tempFileId,
          original_filename: item.originalFileName,
          report_type: item.reportType,
          report_date: resolvedDate,
          report_start_date: resolvedStartDate,
          report_end_date: resolvedEndDate,
          country: effectiveCountry,
          project_name: finalProjectName,
        }
        const res = await fetch(`${API_BASE}/api/v1/${endpoint}/commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const text = await res.text()
          throw new Error(text || '上传失败')
        }
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'success', commitError: null }
              : it,
          ),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败'
        setQueueItems((prev) =>
          prev.map((it) =>
            it.localId === item.localId
              ? { ...it, fileCommitStatus: 'error', commitError: msg }
              : it,
          ),
        )
      }
    }

    setUploading(false)
  }

  const removeItem = (localId: string) => {
    setQueueItems((prev) => prev.filter((it) => it.localId !== localId))
    setRecognitionMap((prev) => {
      const next = { ...prev }
      delete next[localId]
      return next
    })
  }

  const clearAll = () => {
    setQueueItems([])
    setRecognitionMap({})
  }

  const pendingCount = queueItems.filter(
    (it) =>
      it.recognitionStatus === 'recognized' &&
      it.fileCommitStatus !== 'success' &&
      it.fileCommitStatus !== 'saving',
  ).length

  return (
    <div className='flex flex-1 flex-col gap-4'>
      {/* Top controls */}
      <div className='flex shrink-0 items-center gap-3'>
        <Select value={country} onValueChange={(v) => onCountryChange(v as ReportUploadCountry)}>
          <SelectTrigger className='h-10 w-[160px] rounded-md border-border/70 bg-[hsl(var(--surface-overlay))]'>
            <SelectValue placeholder='选择站点' />
          </SelectTrigger>
          <SelectContent>
            {REPORT_UPLOAD_COUNTRY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button onClick={handleUploadAll} disabled={pendingCount === 0 || uploading}>
          {uploading ? (
            <>
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              上传中...
            </>
          ) : (
            <>
              <Upload className='mr-2 h-4 w-4' />
              上传全部 ({pendingCount})
            </>
          )}
        </Button>

        <Button
          variant='outline'
          onClick={clearAll}
          disabled={queueItems.length === 0 || recognizing || uploading}
        >
          清空列表
        </Button>
      </div>

      {/* Dropzone + File list */}
      <div className='grid gap-4 lg:grid-cols-[1fr_2fr] flex-1 overflow-hidden'>
        {/* Dropzone */}
        <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
          <CardContent className='!px-3 !py-3 sm:!px-4 sm:!py-4 flex h-full'>
            <div
              className={cn(
                'relative flex w-full flex-col items-center justify-center rounded-2xl border border-dashed px-5 transition-[border-color,background-color] duration-200',
                dragActive
                  ? 'border-sky-500/70 bg-sky-500/8'
                  : 'border-border/70 bg-[hsl(var(--surface-subtle))]',
              )}
              style={{ flex: 1 }}
              onDrop={(e) => {
                e.preventDefault()
                setDragActive(false)
                void recognizeFiles(Array.from(e.dataTransfer.files))
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
            >
              <input
                id='auto-upload-input'
                type='file'
                multiple
                className='hidden'
                accept='.txt,.csv,.xlsx'
                onChange={(e) => {
                  void recognizeFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              <label
                htmlFor='auto-upload-input'
                className='flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 text-center'
              >
                <div className='flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-[hsl(var(--surface-soft))] shadow-sm sm:h-14 sm:w-14'>
                  <Upload className='h-5 w-5 sm:h-6 sm:w-6 text-sky-600 dark:text-sky-300' />
                </div>
                <div className='space-y-1'>
                  <p className='text-sm font-semibold text-foreground sm:text-base'>
                    拖拽文件到这里，或点击选择
                  </p>
                  <p className='text-xs text-muted-foreground sm:text-sm'>
                    支持 `txt`、`csv`、`xlsx`
                  </p>
                </div>
              </label>
              {recognizing ? (
                <div className='absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 text-sm text-muted-foreground'>
                  <Loader2 className='h-4 w-4 animate-spin' />
                  正在识别...
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* File list */}
        <Card className='overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'>
          <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 pb-3 pt-4'>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle className='text-base'>本次识别文件</CardTitle>
                <CardDescription className='text-xs'>
                  {queueItems.length} 个文件
                </CardDescription>
              </div>
              {uploading ? (
                <Loader2 className='h-4 w-4 animate-spin text-sky-500' />
              ) : null}
            </div>
          </CardHeader>
          <CardContent className='px-0 pt-0 flex h-full overflow-hidden'>
            <ScrollArea className='flex-1 h-full'>
              <div className='space-y-2 p-3'>
                {queueItems.length === 0 ? (
                  <div className='rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))]/45 px-4 py-8 text-center text-sm text-muted-foreground'>
                    暂无文件
                  </div>
                ) : null}
                {queueItems.map((item) => (
                  <div
                    key={item.localId}
                    className={cn(
                      'relative flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-[hsl(var(--surface-subtle))]/85 px-3 py-3 transition-colors duration-300',
                      // 上传成功：整条绿色覆盖
                      item.fileCommitStatus === 'success' && 'border-emerald-400/50 bg-emerald-500/15 dark:bg-emerald-500/20',
                      // 保存中：淡蓝色
                      item.fileCommitStatus === 'saving' && 'border-sky-400/40 bg-sky-500/10 dark:bg-sky-500/15',
                      // 识别错误：淡红色
                      item.recognitionStatus === 'error' && 'border-rose-400/40 bg-rose-500/10',
                    )}
                  >
                    <div className='min-w-0 flex-1 space-y-1'>
                      <p className='truncate text-sm font-medium text-foreground'>
                        {item.originalFileName}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {item.recognitionStatus === 'pending'
                          ? '识别中'
                          : `类型：${getUploadReportTypeLabel(item.reportType)}`}
                      </p>
                      {item.recognitionStatus !== 'pending' ? (
                        <>
                          <p className='text-xs text-muted-foreground'>
                            国家：{item.isMultiCountry
                              ? <span className='text-blue-600 dark:text-blue-400 font-medium'>
                                  {getMultiCountryDisplay(item.detectedCountries)} (自动拆分)
                                </span>
                              : (item.detectedCountry ? getReportUploadCountryLabel(item.detectedCountry, true) : '未识别')
                            }
                          </p>
                          {item.recognizedProject === '未匹配' || item.recognizedProject === null ? (
                            <div className='flex items-center gap-1.5'>
                              <span className='text-xs text-amber-600 dark:text-amber-400'>项目：</span>
                              <Select
                                value={item.userSelectedProject ?? ''}
                                onValueChange={(value) => {
                                  setQueueItems((prev) =>
                                    prev.map((it) =>
                                      it.localId === item.localId
                                        ? { ...it, userSelectedProject: value || null }
                                        : it,
                                    ),
                                  )
                                }}
                              >
                                <SelectTrigger className='h-6 w-[140px] rounded border-border/60 bg-background px-1.5 py-0.5 text-xs'>
                                  <SelectValue placeholder='选择项目' />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableProjects.map((project) => (
                                    <SelectItem key={project} value={project}>
                                      {project}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <p className='text-xs text-muted-foreground'>
                              项目：{item.userSelectedProject ?? item.recognizedProject}
                            </p>
                          )}
                           {item.detectedDate || item.detectedStartDate || item.detectedEndDate ? (
                             <div className='flex flex-col gap-0.5'>
                               <p className='text-xs text-muted-foreground'>
                                 {item.reportType === 'payment_report' ? (
                                   <>
                                     日期范围：
                                     <span className='font-mono'>
                                       {item.userReportStartDate || item.detectedStartDate || '—'} →{' '}
                                       {item.userReportEndDate || item.detectedEndDate || '—'}
                                     </span>
                                     <button
                                       type='button'
                                       onClick={() => {
                                         const start = item.userReportStartDate || item.detectedStartDate || ''
                                         const end = item.userReportEndDate || item.detectedEndDate || ''
                                         setQueueItems((prev) =>
                                           prev.map((it) =>
                                             it.localId === item.localId
                                               ? {
                                                   ...it,
                                                   userReportStartDate: it.userReportStartDate === null ? start : null,
                                                   userReportEndDate: it.userReportEndDate === null ? end : null,
                                                 }
                                               : it,
                                           ),
                                         )
                                       }}
                                       className='ml-1 text-[10px] text-sky-600 hover:text-sky-700 dark:text-sky-400'
                                     >
                                       {item.userReportStartDate ? '取消' : '编辑'}
                                     </button>
                                   </>
                                 ) : (
                                   <>
                                     日期：{item.userReportDate || item.detectedDate}
                                     <button
                                       type='button'
                                       onClick={() => {
                                         setQueueItems((prev) =>
                                           prev.map((it) =>
                                             it.localId === item.localId
                                               ? { ...it, userReportDate: it.userReportDate === null ? item.detectedDate || '' : null }
                                               : it,
                                           ),
                                         )
                                       }}
                                       className='ml-1 text-[10px] text-sky-600 hover:text-sky-700 dark:text-sky-400'
                                     >
                                       {item.userReportDate ? '取消' : '编辑'}
                                     </button>
                                   </>
                                 )}
                               </p>
                               {item.reportType === 'payment_report' && item.userReportStartDate !== null ? (
                                 <div className='flex items-center gap-1.5 pt-0.5'>
                                   <span className='text-[10px] text-amber-600'>起：</span>
                                   <SimpleDatePicker
                                     value={parseDateInputValue(item.userReportStartDate || '')}
                                     onChange={(date) => {
                                       setQueueItems((prev) =>
                                         prev.map((it) =>
                                           it.localId === item.localId
                                             ? { ...it, userReportStartDate: formatDateInputValue(date) }
                                             : it,
                                         ),
                                       )
                                     }}
                                     className='h-6 w-[130px] text-xs'
                                   />
                                   <span className='text-[10px] text-amber-600'>止：</span>
                                   <SimpleDatePicker
                                     value={parseDateInputValue(item.userReportEndDate || '')}
                                     onChange={(date) => {
                                       setQueueItems((prev) =>
                                         prev.map((it) =>
                                           it.localId === item.localId
                                             ? { ...it, userReportEndDate: formatDateInputValue(date) }
                                             : it,
                                         ),
                                       )
                                     }}
                                     className='h-6 w-[130px] text-xs'
                                   />
                                 </div>
                               ) : item.userReportDate !== null && item.reportType !== 'payment_report' ? (
                                 <div className='flex items-center gap-1.5 pt-0.5'>
                                   <span className='text-[10px] text-amber-600'>日期：</span>
                                   <SimpleDatePicker
                                     value={parseDateInputValue(item.userReportDate || '')}
                                     onChange={(date) => {
                                       setQueueItems((prev) =>
                                         prev.map((it) =>
                                           it.localId === item.localId
                                             ? { ...it, userReportDate: formatDateInputValue(date) }
                                             : it,
                                         ),
                                       )
                                     }}
                                     className='h-6 w-[130px] text-xs'
                                   />
                                 </div>
                               ) : null}
                             </div>
                           ) : isDateRequired(item.reportType) ? (
                             <div className='flex items-center gap-1.5'>
                               <span className='text-xs text-amber-600 dark:text-amber-400'>
                                 {item.reportType === 'payment_report' ? '日期范围' : '日期'}：
                               </span>
                               {item.reportType === 'payment_report' ? (
                                 <div className='flex items-center gap-1.5'>
                                   <SimpleDatePicker
                                     value={parseDateInputValue(item.userReportStartDate || '')}
                                     onChange={(date) => {
                                       setQueueItems((prev) =>
                                         prev.map((it) =>
                                           it.localId === item.localId
                                             ? { ...it, userReportStartDate: formatDateInputValue(date) }
                                             : it,
                                         ),
                                       )
                                     }}
                                     className='h-6 w-[130px] text-xs'
                                   />
                                   <span className='text-xs text-muted-foreground'>→</span>
                                   <SimpleDatePicker
                                     value={parseDateInputValue(item.userReportEndDate || '')}
                                     onChange={(date) => {
                                       setQueueItems((prev) =>
                                         prev.map((it) =>
                                           it.localId === item.localId
                                             ? { ...it, userReportEndDate: formatDateInputValue(date) }
                                             : it,
                                         ),
                                       )
                                     }}
                                     className='h-6 w-[130px] text-xs'
                                   />
                                 </div>
                               ) : (
                                 <SimpleDatePicker
                                   value={parseDateInputValue(item.userReportDate || '')}
                                   onChange={(date) => {
                                     setQueueItems((prev) =>
                                       prev.map((it) =>
                                         it.localId === item.localId
                                           ? { ...it, userReportDate: formatDateInputValue(date) }
                                           : it,
                                       ),
                                     )
                                   }}
                                   className='h-6 w-[130px] text-xs'
                                 />
                               )}
                             </div>
                           ) : null}
                          {item.error ? (
                            <p className='text-xs text-rose-600 dark:text-rose-300'>
                              {item.error}
                            </p>
                          ) : null}
                          {item.commitError ? (
                            <p className='text-xs text-rose-600 dark:text-rose-300'>
                              {item.commitError}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <div className='flex items-center gap-1.5'>
                      {item.fileCommitStatus === 'saving' ? (
                        <Loader2 className='h-4 w-4 animate-spin text-sky-600 dark:text-sky-300' />
                      ) : null}
                      {item.fileCommitStatus === 'success' ? (
                        <CheckCircle2 className='h-4 w-4 text-emerald-600 dark:text-emerald-300' />
                      ) : null}
                      {item.fileCommitStatus === 'error' ? (
                        <CircleX className='h-4 w-4 text-rose-600 dark:text-rose-300' />
                      ) : null}
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => removeItem(item.localId)}
                        className='h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:bg-rose-400/10 dark:hover:text-rose-300'
                      >
                        <CircleX className='h-4 w-4' />
                        <span className='sr-only'>移除</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AutoUploadPage() {
  const [activeTab, setActiveTab] = useState<'upload' | 'status'>('status')
  const [uploadSubTab, setUploadSubTab] = useState<UploadEndpoint>('report-upload')
  const [country, setCountry] = useState('US')

  return (
    <div className='flex min-h-[calc(100vh-8rem)] flex-col gap-4 overflow-auto pb-2 sm:gap-6 sm:overflow-hidden lg:min-h-[calc(100vh-8rem)]'>
      {/* Tab switcher */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'upload' | 'status')}>
        <TabsList>
          <TabsTrigger value='upload'>文件上传</TabsTrigger>
          <TabsTrigger value='status'>RPA 状态</TabsTrigger>
        </TabsList>

        {/* Tab content */}
        <TabsContent value='upload' className='mt-4'>
          <Tabs value={uploadSubTab} onValueChange={(v) => setUploadSubTab(v as UploadEndpoint)}>
            <TabsList>
              <TabsTrigger value='report-upload'>通用报表</TabsTrigger>
              <TabsTrigger value='ad-upload'>广告报表</TabsTrigger>
            </TabsList>
            <TabsContent value='report-upload' className='mt-4'>
              <AutoUploadContent
                country={country as ReportUploadCountry}
                onCountryChange={setCountry}
                endpoint='report-upload'
              />
            </TabsContent>
            <TabsContent value='ad-upload' className='mt-4'>
              <AutoUploadContent
                country={country as ReportUploadCountry}
                onCountryChange={setCountry}
                endpoint='ad-upload'
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value='status' className='mt-4'>
          <RpaStatusGrid country={country} onCountryChange={setCountry} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
