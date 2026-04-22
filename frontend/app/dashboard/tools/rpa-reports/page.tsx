'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleX,
  LayoutDashboard,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  SingleDatePicker,
  formatDateInputValue,
  parseDateInputValue,
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
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

const API_BASE = '/api/backend'

const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/Los_Angeles',
  DE: 'Europe/Berlin',
  UK: 'Europe/London',
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站' },
  { value: 'DE', label: '德国站' },
  { value: 'UK', label: '英国站' },
]

function getTodayInTimezone(country: string): Date {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function toLocalDateInputValue(input?: Date, country?: string): string {
  const date = input ?? (country ? getTodayInTimezone(country) : new Date())
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

// 报表类型配置：key 对应后端 REPORT_TYPES，label 是列头显示名，active 表示当前已启用
const REPORT_TYPES = [
  { key: 'inventory_report',      label: '库存',      active: true },
  { key: 'business_report',        label: '业务',      active: true },
  { key: 'ad_product_report',     label: '广告',      active: true },
  { key: 'sales_report',           label: '销售',      active: true },
  { key: 'payment_report',         label: '付款',      active: true },
  { key: 'return_report',          label: '退货',      active: true },
  { key: 'storage_report',        label: '仓储',      active: false },
  { key: 'returns_detail_report',  label: '退货明细',  active: false },
  { key: 'fba_inventory_report',   label: 'FBA库存',   active: false },
  { key: 'reimbursement_report',   label: '赔偿',      active: false },
  { key: 'tax_invoice_report',     label: '税务发票',  active: false },
  { key: 'health_report',          label: '健康报告',  active: false },
  { key: 'advertising_reports',    label: '广告报表',  active: false },
  { key: 'brand_report',           label: '品牌报表',  active: false },
  { key: 'vendor_report',          label: '供应商',    active: false },
]

const TABLE_HEADER_HEIGHT_CLASS = 'h-[clamp(3.5rem,3.8vh,4.25rem)] min-h-14 max-h-[4.25rem]'
const TABLE_ROW_HEIGHT_CLASS = 'h-[clamp(2.8rem,3.2vh,3.5rem)] min-h-[2.8rem] max-h-[3.5rem]'

export default function RpaReportsPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])

  const [statusRows, setStatusRows] = useState<ProjectRow[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [country, setCountry] = useState('US')
  const [statusDate, setStatusDate] = useState(() => toLocalDateInputValue(undefined, 'US'))

  useEffect(() => {
    setStatusDate(toLocalDateInputValue(undefined, country))
  }, [country])

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

  useEffect(() => {
    const loadStatus = async () => {
      setStatusLoading(true)
      setStatusError(null)
      try {
        const query = new URLSearchParams({
          report_date: statusDate,
          country,
        })
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
    void loadStatus()
  }, [statusDate, country])

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
    <div className='flex w-full min-h-0 flex-col text-foreground'>
      <Card
        className='flex h-[calc(100vh-6.5rem)] min-h-0 flex-col overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-sm'
      >
        <CardHeader className='border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-5 md:px-8 shrink-0'>
          <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
            <div className='flex items-center gap-3'>
              <div className='flex h-11 w-11 items-center justify-center rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] text-muted-foreground'>
                <LayoutDashboard className='h-5 w-5' />
              </div>
              <div className='space-y-1'>
                <CardTitle>RPA 报表状态</CardTitle>
                <p className='text-sm text-muted-foreground'>
                  查看 RPA 自动接入的报表入库情况（autoReportUpload）
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

              <Select value={country} onValueChange={(value) => setCountry(value)}>
                <SelectTrigger className='h-10 w-[160px] rounded-md border-border/70 bg-background dark:bg-[hsl(var(--surface-soft))]'>
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

              <Button
                type='button'
                variant='outline'
                size='icon'
                onClick={() => setStatusDate((v) => shiftDateString(v, -1))}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <SingleDatePicker
                value={parseDateInputValue(statusDate)}
                onChange={(date) => setStatusDate(formatDateInputValue(date))}
                className='w-[180px] bg-background dark:bg-[hsl(var(--surface-soft))]'
              />
              <Button
                type='button'
                variant='outline'
                size='icon'
                onClick={() => setStatusDate((v) => shiftDateString(v, 1))}
              >
                <ChevronRight className='h-4 w-4' />
              </Button>
              <Button
                type='button'
                variant='secondary'
                onClick={() => setStatusDate(toLocalDateInputValue(undefined, country))}
              >
                今天
              </Button>
            </div>
          </div>
        </CardHeader>

        <div className='flex min-h-0 flex-1 flex-col p-0'>
          {statusError ? (
            <p className='py-4 pl-6 text-sm text-rose-600'>{statusError}</p>
          ) : null}

          {statusLoading ? (
            <div className='flex min-h-0 flex-1 flex-col space-y-3'>
              <Skeleton className='h-10 w-full rounded-none shrink-0' />
              <Skeleton className='flex-1 w-full rounded-none min-h-0' />
            </div>
          ) : (
            <div className='flex min-h-0 flex-1 flex-col overflow-auto'>
              {/* 表头 */}
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
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
