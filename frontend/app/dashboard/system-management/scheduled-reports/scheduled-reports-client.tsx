'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import Image from 'next/image'
import ReactMarkdown from 'react-markdown'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { ImagePreviewDialog, PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Plus, Trash2, Mail, Calendar, ImageIcon, Copy, FileText, RotateCcw, AlertTriangle, Pencil, Power } from 'lucide-react'
import { DateRangePicker, parseDateRangeInputValue } from '@/components/ui/date-picker'
import type { DateRange } from 'react-day-picker'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { cn } from '@/lib/utils'

// 内部表单组件：抽取为子组件，便于在 Dialog 中复用
interface SubscriptionFormProps {
  mode: 'create' | 'edit'
  editingSub?: Subscription | null
  formEmail: string
  setFormEmail: (v: string) => void
  formProjectIds: string
  setFormProjectIds: (v: string) => void
  formCountry: string
  setFormCountry: (v: string) => void
  formFrequency: Frequency
  setFormFrequency: (v: Frequency) => void
  formDispatchHour: number
  setFormDispatchHour: (v: number) => void
  formDispatchMinute: number
  setFormDispatchMinute: (v: number) => void
  formDispatchWeekday: number
  setFormDispatchWeekday: (v: number) => void
  formDispatchDay: number
  setFormDispatchDay: (v: number) => void
  formAiModel: string
  setFormAiModel: (v: string) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  formError: string | null
  testResult: { success: boolean; message: string } | null
  formSubmitting: boolean
  testingEmail: boolean
  onTestEmail: () => void
  onSubmit: () => void
  onCancel: () => void
  allowedHourOptions: number[]
  isMondayRestricted: boolean
}

function SubscriptionForm({
  mode,
  formEmail, setFormEmail,
  formProjectIds, setFormProjectIds,
  formCountry, setFormCountry,
  formFrequency, setFormFrequency,
  formDispatchHour, setFormDispatchHour,
  formDispatchMinute, setFormDispatchMinute,
  formDispatchWeekday, setFormDispatchWeekday,
  formDispatchDay, setFormDispatchDay,
  formAiModel, setFormAiModel,
  projects,
  modelConfig,
  isLoadingModelConfig,
  formError,
  testResult,
  formSubmitting,
  testingEmail,
  onTestEmail,
  onSubmit,
  onCancel,
  allowedHourOptions,
  isMondayRestricted,
}: SubscriptionFormProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === 'create' ? '新增订阅' : '编辑订阅'}</DialogTitle>
        <DialogDescription>
          {mode === 'create' ? '创建新的报告订阅配置' : '修改订阅配置'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2 max-h-[70vh] overflow-y-auto pr-2">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium mb-1 block">邮箱地址</label>
            <Input
              type="email"
              placeholder="ops@company.com"
              value={formEmail}
              onChange={e => setFormEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">推送频率</label>
            <Select value={formFrequency} onValueChange={v => {
              const newFreq = v as Frequency
              setFormFrequency(newFreq)
              if (newFreq === 'weekly' && formDispatchWeekday === 0 && formDispatchHour < MIN_HOUR_FOR_MONDAY) {
                setFormDispatchHour(MIN_HOUR_FOR_MONDAY)
              }
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">每日</SelectItem>
                <SelectItem value="weekly">每周</SelectItem>
                <SelectItem value="monthly">每月</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              发送时间（北京时间）
              {isMondayRestricted && (
                <span className="ml-1.5 text-xs text-amber-600 font-normal">（周一限制 ≥ 16:00）</span>
              )}
            </label>
            <div className="flex gap-1.5 items-center">
              <Select value={String(formDispatchHour)} onValueChange={v => setFormDispatchHour(Number(v))}>
                <SelectTrigger className="w-[80px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {allowedHourOptions.map(h => (
                    <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00{isMondayRestricted && h === MIN_HOUR_FOR_MONDAY ? ' 起' : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">:</span>
              <Select value={String(formDispatchMinute)} onValueChange={v => setFormDispatchMinute(Number(v))}>
                <SelectTrigger className="w-[80px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => (
                    <SelectItem key={i * 5} value={String(i * 5)}>{(i * 5).toString().padStart(2, '0')}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">国家站点</label>
            <Select value={formCountry} onValueChange={setFormCountry}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="US">美国 (US)</SelectItem>
                <SelectItem value="CA">加拿大 (CA)</SelectItem>
                <SelectItem value="UK">英国 (UK)</SelectItem>
                <SelectItem value="DE">德国 (DE)</SelectItem>
                <SelectItem value="JP">日本 (JP)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formFrequency === 'weekly' && (
            <div>
              <label className="text-sm font-medium mb-1 block">发送星期</label>
              <Select value={String(formDispatchWeekday)} onValueChange={v => {
                const newWeekday = Number(v)
                setFormDispatchWeekday(newWeekday)
                if (newWeekday === 0 && formDispatchHour < MIN_HOUR_FOR_MONDAY) {
                  setFormDispatchHour(MIN_HOUR_FOR_MONDAY)
                }
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAY_LABELS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>{i === 0 ? `${label}（最早 16:00）` : label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {formFrequency === 'monthly' && (
            <div>
              <label className="text-sm font-medium mb-1 block">发送日期</label>
              <Select value={String(formDispatchDay)} onValueChange={v => setFormDispatchDay(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-[240px]">
                  {Array.from({ length: 27 }, (_, i) => (
                    <SelectItem key={i + 2} value={String(i + 2)}>{i + 2} 日</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="text-sm font-medium mb-1 block">项目范围</label>
            <Select value={formProjectIds} onValueChange={setFormProjectIds}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="*">全部项目</SelectItem>
                {projects.map(p => (
                  <SelectItem key={p.name} value={p.id?.toString() || p.name}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">AI 模型</label>
            <Select
              value={formAiModel}
              onValueChange={setFormAiModel}
              disabled={isLoadingModelConfig || !modelConfig?.models.length}
            >
              <SelectTrigger>
                <SelectValue placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'} />
              </SelectTrigger>
              <SelectContent>
                {(modelConfig?.premiumModels.length || 0) > 0 && (
                  <SelectGroup>
                    <SelectLabel>高级模型</SelectLabel>
                    {modelConfig?.premiumModels.map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {(modelConfig?.basicModels.length || 0) > 0 && (
                  <SelectGroup>
                    <SelectLabel>基础模型</SelectLabel>
                    {modelConfig?.basicModels.map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {modelConfig?.models
                  .filter(m => !modelConfig.premiumModels.includes(m) && !modelConfig.basicModels.includes(m))
                  .map(m => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {formError && <p className="text-sm text-destructive">{formError}</p>}
        {testResult && (
          <p className={cn('text-sm', testResult.success ? 'text-emerald-600' : 'text-destructive')}>
            {testResult.message}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="outline" onClick={onTestEmail} disabled={testingEmail || !formEmail}>
            {testingEmail ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Mail className="mr-1 h-4 w-4" />}
            发送测试邮件
          </Button>
          <Button onClick={onSubmit} disabled={formSubmitting}>
            {formSubmitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {mode === 'create' ? '确认创建' : '保存修改'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>取消</Button>
        </div>
      </div>
    </>
  )
}

// 新增订阅 Dialog
function CreateSubscriptionDialog({
  open,
  onOpenChange,
  projects,
  modelConfig,
  isLoadingModelConfig,
  allowedHourOptions,
  isMondayRestricted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  allowedHourOptions: number[]
  isMondayRestricted: boolean
}) {
  const [formEmail, setFormEmail] = useState('')
  const [formProjectIds, setFormProjectIds] = useState('*')
  const [formCountry, setFormCountry] = useState('US')
  const [formFrequency, setFormFrequency] = useState<Frequency>('daily')
  const [formDispatchHour, setFormDispatchHour] = useState(15)
  const [formDispatchMinute, setFormDispatchMinute] = useState(0)
  const [formDispatchWeekday, setFormDispatchWeekday] = useState(0)
  const [formDispatchDay, setFormDispatchDay] = useState(2)
  const [formAiModel, setFormAiModel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)

  const session = useSession().data

  useEffect(() => {
    if (open && modelConfig?.defaultModel) {
      setFormAiModel(modelConfig.defaultModel)
    }
  }, [open, modelConfig?.defaultModel])

  const handleTestEmail = async () => {
    if (!formEmail.trim()) {
      setTestResult({ success: false, message: '请先填写测试邮箱地址' })
      return
    }
    setTestingEmail(true)
    setTestResult(null)
    try {
      const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/test-email'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, frequency: formFrequency, project_ids: formProjectIds, country: formCountry, ai_model: formAiModel || null }),
      })
      const data = await res.json()
      setTestResult({ success: data.success, message: data.message })
    } catch (e) {
      setTestResult({ success: false, message: normalizeErrorMessage(e, '发送失败') })
    } finally {
      setTestingEmail(false)
    }
  }

  const handleSubmit = async () => {
    if (!formEmail.trim()) {
      setFormError('请填写邮箱地址')
      return
    }
    setFormSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency, dispatch_hour: formDispatchHour, dispatch_minute: formDispatchMinute, dispatch_weekday: formFrequency === 'weekly' ? formDispatchWeekday : null, dispatch_day: formFrequency === 'monthly' ? formDispatchDay : null, ai_model: formAiModel || null }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || '创建失败')
      }
      onOpenChange(false)
      // 触发父组件刷新
      window.location.reload()
    } catch (e) {
      setFormError(normalizeErrorMessage(e, '创建失败'))
    } finally {
      setFormSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <SubscriptionForm
          mode="create"
          formEmail={formEmail} setFormEmail={setFormEmail}
          formProjectIds={formProjectIds} setFormProjectIds={setFormProjectIds}
          formCountry={formCountry} setFormCountry={setFormCountry}
          formFrequency={formFrequency} setFormFrequency={setFormFrequency}
          formDispatchHour={formDispatchHour} setFormDispatchHour={setFormDispatchHour}
          formDispatchMinute={formDispatchMinute} setFormDispatchMinute={setFormDispatchMinute}
          formDispatchWeekday={formDispatchWeekday} setFormDispatchWeekday={setFormDispatchWeekday}
          formDispatchDay={formDispatchDay} setFormDispatchDay={setFormDispatchDay}
          formAiModel={formAiModel} setFormAiModel={setFormAiModel}
          projects={projects}
          modelConfig={modelConfig}
          isLoadingModelConfig={isLoadingModelConfig}
          formError={formError}
          testResult={testResult}
          formSubmitting={formSubmitting}
          testingEmail={testingEmail}
          onTestEmail={handleTestEmail}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          allowedHourOptions={allowedHourOptions}
          isMondayRestricted={isMondayRestricted}
        />
      </DialogContent>
    </Dialog>
  )
}

// 编辑订阅 Dialog
function EditSubscriptionDialog({
  subscription,
  open,
  onOpenChange,
  projects,
  modelConfig,
  isLoadingModelConfig,
  allowedHourOptions,
  isMondayRestricted,
}: {
  subscription: Subscription | null
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  allowedHourOptions: number[]
  isMondayRestricted: boolean
}) {
  const [formEmail, setFormEmail] = useState('')
  const [formProjectIds, setFormProjectIds] = useState('*')
  const [formCountry, setFormCountry] = useState('US')
  const [formFrequency, setFormFrequency] = useState<Frequency>('daily')
  const [formDispatchHour, setFormDispatchHour] = useState(15)
  const [formDispatchMinute, setFormDispatchMinute] = useState(0)
  const [formDispatchWeekday, setFormDispatchWeekday] = useState(0)
  const [formDispatchDay, setFormDispatchDay] = useState(2)
  const [formAiModel, setFormAiModel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)

  useEffect(() => {
    if (subscription) {
      setFormEmail(subscription.email)
      setFormProjectIds(subscription.project_ids)
      setFormCountry(subscription.country)
      setFormFrequency(subscription.frequency)
      setFormDispatchHour(subscription.dispatch_hour)
      setFormDispatchMinute(subscription.dispatch_minute ?? 0)
      setFormDispatchWeekday(subscription.dispatch_weekday ?? 0)
      setFormDispatchDay(subscription.dispatch_day ?? 2)
      setFormAiModel(subscription.ai_model || modelConfig?.defaultModel || '')
      setFormError(null)
      setTestResult(null)
    }
  }, [subscription, modelConfig?.defaultModel])

  const handleTestEmail = async () => {
    if (!formEmail.trim()) {
      setTestResult({ success: false, message: '请先填写测试邮箱地址' })
      return
    }
    setTestingEmail(true)
    setTestResult(null)
    try {
      const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/test-email'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, frequency: formFrequency, project_ids: formProjectIds, country: formCountry, ai_model: formAiModel || null }),
      })
      const data = await res.json()
      setTestResult({ success: data.success, message: data.message })
    } catch (e) {
      setTestResult({ success: false, message: normalizeErrorMessage(e, '发送失败') })
    } finally {
      setTestingEmail(false)
    }
  }

  const handleSubmit = async () => {
    if (!formEmail.trim()) {
      setFormError('请填写邮箱地址')
      return
    }
    if (!subscription) return
    setFormSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${subscription.id}`), {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency, dispatch_hour: formDispatchHour, dispatch_minute: formDispatchMinute, dispatch_weekday: formFrequency === 'weekly' ? formDispatchWeekday : null, dispatch_day: formFrequency === 'monthly' ? formDispatchDay : null, ai_model: formAiModel || null }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || '更新失败')
      }
      onOpenChange(false)
      window.location.reload()
    } catch (e) {
      setFormError(normalizeErrorMessage(e, '更新失败'))
    } finally {
      setFormSubmitting(false)
    }
  }

  if (!subscription) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <SubscriptionForm
          mode="edit"
          editingSub={subscription}
          formEmail={formEmail} setFormEmail={setFormEmail}
          formProjectIds={formProjectIds} setFormProjectIds={setFormProjectIds}
          formCountry={formCountry} setFormCountry={setFormCountry}
          formFrequency={formFrequency} setFormFrequency={setFormFrequency}
          formDispatchHour={formDispatchHour} setFormDispatchHour={setFormDispatchHour}
          formDispatchMinute={formDispatchMinute} setFormDispatchMinute={setFormDispatchMinute}
          formDispatchWeekday={formDispatchWeekday} setFormDispatchWeekday={setFormDispatchWeekday}
          formDispatchDay={formDispatchDay} setFormDispatchDay={setFormDispatchDay}
          formAiModel={formAiModel} setFormAiModel={setFormAiModel}
          projects={projects}
          modelConfig={modelConfig}
          isLoadingModelConfig={isLoadingModelConfig}
          formError={formError}
          testResult={testResult}
          formSubmitting={formSubmitting}
          testingEmail={testingEmail}
          onTestEmail={handleTestEmail}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          allowedHourOptions={allowedHourOptions}
          isMondayRestricted={isMondayRestricted}
        />
      </DialogContent>
    </Dialog>
  )
}

const API_BASE = '/api/backend'

type Frequency = 'daily' | 'weekly' | 'monthly'
type Subscription = {
  id: number
  user_id: number | null
  email: string
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday: number | null
  dispatch_day: number | null
  ai_model: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

type LedgerStatus = 'sent' | 'failed' | 'missing'
type ResendStage = 'preparing' | 'building' | 'sending' | 'done' | 'failed'

const RESEND_STAGE_LABELS: Record<ResendStage, string> = {
  preparing: '准备中',
  building: '构建报表',
  sending: '发送中',
  done: '已完成',
  failed: '失败',
}

const RESEND_STAGE_COLORS: Record<ResendStage, string> = {
  preparing: 'text-amber-600 dark:text-amber-400',
  building: 'text-blue-600 dark:text-blue-400',
  sending: 'text-purple-600 dark:text-purple-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
}

type LedgerItem = {
  id: number
  ledger_key: string
  expected_date: string
  expected_at: string
  frequency: Frequency
  subscription_id: number
  email: string
  project_ids: string
  project_names: string[]
  country: string
  status: LedgerStatus
  latest_delivery_log_id: number | null
  error_message: string | null
  sent_at: string | null
  can_resend: boolean
  last_checked_at: string
  screenshot_r2_url: string | null
  screenshot_r2_thumb_url: string | null
  ai_summary: string | null
}
type LedgerSummary = {
  expected: number
  sent: number
  failed: number
  missing: number
  resendable: number
}

type AIModelConfig = {
  providerConfigured: boolean
  models: string[]
  defaultModel: string
  premiumModels: string[]
  basicModels: string[]
}

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}
const FREQUENCY_COLORS: Record<Frequency, string> = {
  daily: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  weekly: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  monthly: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
}
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// 周报周一最早 16:00
const MIN_HOUR_FOR_MONDAY = 16

function authHeaders(): Record<string, string> {
  return {}
}

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

/**
 * 将 project_ids 字符串转换为项目名称列表。
 * project_ids 格式: "15" | "*" | "15,4,8"
 */
function resolveProjectNames(projectIds: string, projects: Array<{ id?: number | null; name: string }>): string[] {
  if (projectIds === '*') return ['全部项目']
  const ids = projectIds.split(',').map(id => id.trim()).filter(Boolean)
  return ids
    .map(id => {
      const idNum = parseInt(id, 10)
      const found = projects.find(p => p.id === idNum)
      return found ? found.name : `项目${id}`
    })
    .filter(name => name)
}

/**
 * 格式化项目名称列表为截断字符串。
 * 超过 maxNames 项时截断并显示 +N。
 */
function formatProjectNames(projectNames: string[], maxNames: number = 2): { display: string; full: string } {
  if (projectNames.length === 0) return { display: '全部项目', full: '全部项目' }
  if (projectNames.length <= maxNames) {
    return { display: projectNames.join(', '), full: projectNames.join(', ') }
  }
  const shown = projectNames.slice(0, maxNames)
  const hidden = projectNames.length - maxNames
  return {
    display: `${shown.join(', ')} +${hidden}`,
    full: projectNames.join(', '),
  }
}

export function ScheduledReportsClient() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSub, setEditingSub] = useState<Subscription | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [filterFrequency, setFilterFrequency] = useState<string>('all')
  const [filterProject, setFilterProject] = useState<string>('all')
  const [filterEmail, setFilterEmail] = useState<string>('')
  const [filterCountry, setFilterCountry] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [formEmail, setFormEmail] = useState('')
  const [formProjectIds, setFormProjectIds] = useState('*')
  const [formCountry, setFormCountry] = useState('US')
  const [formFrequency, setFormFrequency] = useState<Frequency>('daily')
  const [formDispatchHour, setFormDispatchHour] = useState(15)
  const [formDispatchMinute, setFormDispatchMinute] = useState(0)
  const [formDispatchWeekday, setFormDispatchWeekday] = useState(0)
  const [formDispatchDay, setFormDispatchDay] = useState(2)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [testingEmail, setTestingEmail] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [formAiModel, setFormAiModel] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [previewScreenshotUrl, setPreviewScreenshotUrl] = useState<string | null>(null)
  const [previewSummary, setPreviewSummary] = useState<string | null>(null)

  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 30)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [ledgerStartDate, setLedgerStartDate] = useState(thirtyDaysAgo.toISOString().slice(0, 10))
  const [ledgerEndDate, setLedgerEndDate] = useState(today.toISOString().slice(0, 10))

  // Sync DateRange to separate start/end state
  const handleLedgerDateRangeChange = (range: DateRange | undefined) => {
    setLedgerStartDate(range?.from ? range.from.toISOString().slice(0, 10) : '')
    setLedgerEndDate(range?.to ? range.to.toISOString().slice(0, 10) : '')
  }
  const [ledgerFrequency, setLedgerFrequency] = useState<string>('all')
  const [ledgerStatus, setLedgerStatus] = useState<string>('all')
  const [ledgerEmail, setLedgerEmail] = useState('')
  const [resendingStates, setResendingStates] = useState<Record<string, ResendStage>>({})

  // 轮询 delivery_log 状态直到完成或失败
  const pollDeliveryLogStatus = async (ledgerKey: string, deliveryLogId: number) => {
    const poll = async () => {
      try {
        const res = await fetch(
          resolveApiUrl(`/api/v1/scheduled-reports/delivery-logs?limit=1`),
          { headers: authHeaders() }
        )
        if (!res.ok) return
        const data = await res.json()
        const log = data.items?.find((l: { id: number }) => l.id === deliveryLogId)
        if (!log) return

        const stage = log.stage as ResendStage
        setResendingStates(prev => ({ ...prev, [ledgerKey]: stage }))

        // 轮询直到完成或失败
        if (stage === 'done' || stage === 'failed') {
          // 刷新台账
          await loadLedger()
          // 清理状态
          setTimeout(() => {
            setResendingStates(prev => {
              const next = { ...prev }
              delete next[ledgerKey]
              return next
            })
          }, 1500)
          return
        }

        // 继续轮询（2秒间隔）
        setTimeout(poll, 2000)
      } catch (e) {
        console.error('Poll error:', e)
        // 失败时延长间隔
        setTimeout(poll, 4000)
      }
    }
    poll()
  }

  // 动态计算小时可选范围（周报周一限制 16:00）
  const allowedHourOptions = (() => {
    if (formFrequency !== 'weekly' || formDispatchWeekday !== 0) {
      return Array.from({ length: 24 }, (_, i) => i)
    }
    // 周一只能选 16~23
    return Array.from({ length: 8 }, (_, i) => i + MIN_HOUR_FOR_MONDAY)
  })()

  const isMondayRestricted = formFrequency === 'weekly' && formDispatchWeekday === 0

  // Load model config on mount
  useEffect(() => {
    async function loadModelConfig() {
      setIsLoadingModelConfig(true)
      try {
        const res = await fetch('/api/ai-chat/config', {
          method: 'GET',
          cache: 'no-store',
        })
        const payload = await res.json() as AIModelConfig
        if (res.ok) {
          setModelConfig(payload)
          setFormAiModel(payload.defaultModel || '')
        }
      } catch (e) {
        console.error('Failed to load AI model config', e)
      } finally {
        setIsLoadingModelConfig(false)
      }
    }
    void loadModelConfig()
  }, [])

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [subRes, projectData] = await Promise.all([
          fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), { headers: authHeaders() }),
          fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
        ])
        const subs = subRes.ok ? await subRes.json() : { items: [] }
        setSubscriptions(subs.items || [])
        setProjects(projectData.filter(p => typeof p.name === 'string' && p.name.trim()))
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [session])

  useEffect(() => {
    void loadLedger()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCreate = async () => {
    if (!formEmail.trim()) {
      setFormError('请填写邮箱地址')
      return
    }
    setFormSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency, dispatch_hour: formDispatchHour, dispatch_minute: formDispatchMinute, dispatch_weekday: formFrequency === 'weekly' ? formDispatchWeekday : null, dispatch_day: formFrequency === 'monthly' ? formDispatchDay : null, ai_model: formAiModel || null }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || '创建失败')
      }
      const sub = await res.json()
      setSubscriptions(prev => [sub, ...prev])
      setShowForm(false)
      setFormEmail('')
      setFormProjectIds('*')
      setFormCountry('US')
      setFormFrequency('daily')
      setFormDispatchHour(15)
      setFormDispatchMinute(0)
      setFormDispatchWeekday(0)
      setFormDispatchDay(2)
      setFormAiModel(modelConfig?.defaultModel || '')
    } catch (e) {
      setFormError(normalizeErrorMessage(e, '创建失败'))
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleUpdate = async () => {
    if (!formEmail.trim()) {
      setFormError('请填写邮箱地址')
      return
    }
    if (editingId === null) return
    setFormSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${editingId}`), {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency, dispatch_hour: formDispatchHour, dispatch_minute: formDispatchMinute, dispatch_weekday: formFrequency === 'weekly' ? formDispatchWeekday : null, dispatch_day: formFrequency === 'monthly' ? formDispatchDay : null, ai_model: formAiModel || null }),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || '更新失败')
      }
      const updated = await res.json()
      setSubscriptions(prev => prev.map(s => s.id === editingId ? updated : s))
      setShowForm(false)
      setEditingId(null)
      setFormEmail('')
      setFormProjectIds('*')
      setFormCountry('US')
      setFormFrequency('daily')
      setFormDispatchHour(15)
      setFormDispatchMinute(0)
      setFormDispatchWeekday(0)
      setFormDispatchDay(2)
      setFormAiModel(modelConfig?.defaultModel || '')
    } catch (e) {
      setFormError(normalizeErrorMessage(e, '更新失败'))
    } finally {
      setFormSubmitting(false)
    }
  }

  // 过滤后的订阅列表
  const filteredSubscriptions = subscriptions.filter(sub => {
    if (filterFrequency !== 'all' && sub.frequency !== filterFrequency) return false
    if (filterProject !== 'all') {
      const ids = sub.project_ids === '*' ? [] : sub.project_ids.split(',').map(id => id.trim())
      if (!ids.includes(filterProject)) return false
    }
    if (filterEmail.trim() && !sub.email.toLowerCase().includes(filterEmail.toLowerCase())) return false
    if (filterCountry !== 'all' && sub.country !== filterCountry) return false
    if (filterStatus !== 'all') {
      const isEnabled = sub.enabled
      if (filterStatus === 'enabled' && !isEnabled) return false
      if (filterStatus === 'disabled' && isEnabled) return false
    }
    return true
  })

  const handleEdit = (sub: Subscription) => {
    setEditingSub(sub)
    setShowEditDialog(true)
  }

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: '确定删除此订阅？', variant: 'destructive' })) return
    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (res.ok) {
        setSubscriptions(prev => prev.filter(s => s.id !== id))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleToggle = async (sub: Subscription) => {
    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${sub.id}`), {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled }),
      })
      if (res.ok) {
        const updated = await res.json()
        setSubscriptions(prev => prev.map(s => s.id === sub.id ? updated : s))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const loadLedger = async () => {
    setLedgerLoading(true)
    setLedgerError(null)
    try {
      const params = new URLSearchParams({
        start_date: ledgerStartDate,
        end_date: ledgerEndDate,
        frequency: ledgerFrequency,
        status_filter: ledgerStatus,
        limit: '100',
      })
      if (ledgerEmail.trim()) params.set('email', ledgerEmail.trim())
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/ledger?${params.toString()}`), {
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json() as { items: LedgerItem[]; summary: LedgerSummary }
      setLedgerItems(data.items || [])
      setLedgerSummary(data.summary || null)
    } catch (e) {
      setLedgerError(normalizeErrorMessage(e, '加载台账失败'))
    } finally {
      setLedgerLoading(false)
    }
  }

  const handleResendLedger = async (item: LedgerItem) => {
    if (!item.can_resend) return
    const actionLabel = item.status === 'failed' ? '重试' : '补发'
    if (!await confirm({ title: `确认${actionLabel} ${item.expected_date} 的 ${FREQUENCY_LABELS[item.frequency]} 报告？` })) return

    // 初始化状态为 preparing
    setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))

    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(item.ledger_key)}/resend`), {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(await res.text())

      const data = await res.json()

      // 如果返回了 delivery_log_id，开始轮询状态
      if (data.delivery_log_id) {
        pollDeliveryLogStatus(item.ledger_key, data.delivery_log_id)
      } else {
        // 旧版接口，直接刷新
        setResendingStates(prev => {
          const next = { ...prev }
          delete next[item.ledger_key]
          return next
        })
        await loadLedger()
      }
    } catch (e) {
      setResendingStates(prev => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      notify({ type: 'error', title: `${actionLabel}失败`, message: normalizeErrorMessage(e) })
    }
  }

  const handleTestEmail = async () => {
    if (!formEmail.trim()) {
      setTestResult({ success: false, message: '请先填写测试邮箱地址' })
      return
    }
    setTestingEmail(true)
    setTestResult(null)
    try {
      const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/test-email'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, frequency: formFrequency, project_ids: formProjectIds, country: formCountry, ai_model: formAiModel || null }),
      })
      const data = await res.json()
      setTestResult({ success: data.success, message: data.message })
    } catch (e) {
      setTestResult({ success: false, message: normalizeErrorMessage(e, '发送失败') })
    } finally {
      setTestingEmail(false)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <>
    <Tabs defaultValue="subscriptions" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="subscriptions">订阅管理</TabsTrigger>
          <TabsTrigger value="ledger">调度记录</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions">
          <div className="space-y-4">
            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-0">
                <div className="p-4 border-b border-border/60">
                  <div className="flex gap-3 flex-wrap">
                    <Select value={filterFrequency} onValueChange={setFilterFrequency}>
                      <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="频率" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部频率</SelectItem>
                        <SelectItem value="daily">每日</SelectItem>
                        <SelectItem value="weekly">每周</SelectItem>
                        <SelectItem value="monthly">每月</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterProject} onValueChange={setFilterProject}>
                      <SelectTrigger className="w-[160px] h-9"><SelectValue placeholder="项目" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部项目</SelectItem>
                        {projects.map(p => (
                          <SelectItem key={p.id?.toString() || p.name} value={p.id?.toString() || ''}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={filterCountry} onValueChange={setFilterCountry}>
                      <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="国家" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部国家</SelectItem>
                        <SelectItem value="US">美国</SelectItem>
                        <SelectItem value="CA">加拿大</SelectItem>
                        <SelectItem value="UK">英国</SelectItem>
                        <SelectItem value="DE">德国</SelectItem>
                        <SelectItem value="JP">日本</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterStatus} onValueChange={setFilterStatus}>
                      <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="状态" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部状态</SelectItem>
                        <SelectItem value="enabled">启用</SelectItem>
                        <SelectItem value="disabled">已暂停</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="筛选邮箱"
                      value={filterEmail}
                      onChange={e => setFilterEmail(e.target.value)}
                      className="w-[200px] h-9"
                    />
                    <div className="ml-auto flex gap-2">
                      <Button size="sm" onClick={() => setShowCreateDialog(true)}>
                        <Plus className="mr-1 h-4 w-4" />新增订阅
                      </Button>
                    </div>
                  </div>
                </div>
                {subscriptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">暂无订阅配置，点击上方按钮添加</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/60">
                          <TableHead>项目</TableHead>
                          <TableHead>国家</TableHead>
                          <TableHead>频率</TableHead>
                          <TableHead>发送时间</TableHead>
                          <TableHead>邮箱</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>AI 模型</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSubscriptions.map(sub => {
                          const names = resolveProjectNames(sub.project_ids, projects)
                          const { display, full } = formatProjectNames(names)
                          const weekdayLabel = sub.frequency === 'weekly' ? ` 周${['一','二','三','四','五','六','日'][sub.dispatch_weekday ?? 0]}` : ''
                          const dayLabel = sub.frequency === 'monthly' ? ` ${sub.dispatch_day ?? 2}日` : ''
                          return (
                            <TableRow key={sub.id}>
                              <TableCell>
                                <span className="font-medium truncate max-w-[140px] block" title={full}>
                                  {display}
                                </span>
                              </TableCell>
                              <TableCell className="text-muted-foreground">{sub.country}</TableCell>
                              <TableCell>
                                <Badge className={cn('text-xs', FREQUENCY_COLORS[sub.frequency])}>
                                  {FREQUENCY_LABELS[sub.frequency]}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {sub.dispatch_hour.toString().padStart(2, '0')}:{sub.dispatch_minute.toString().padStart(2, '0')}{weekdayLabel}{dayLabel}
                              </TableCell>
                              <TableCell>
                                <span className="text-muted-foreground truncate max-w-[160px] block" title={sub.email}>
                                  {sub.email}
                                </span>
                              </TableCell>
                              <TableCell>
                                {sub.enabled ? (
                                  <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200">启用</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-xs text-muted-foreground">已暂停</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {sub.ai_model || '—'}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex gap-1 justify-end">
                                  <Button size="sm" variant="ghost" onClick={() => handleToggle(sub)} title={sub.enabled ? '暂停' : '启用'}>
                                    <Power className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => handleEdit(sub)}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDelete(sub.id)}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ledger">
          <div className="space-y-4">
            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-4 space-y-4">
                <div className="flex gap-3 flex-wrap">
                  <DateRangePicker
                    value={parseDateRangeInputValue(ledgerStartDate, ledgerEndDate)}
                    onChange={handleLedgerDateRangeChange}
                    className="h-9 w-[280px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none"
                  />
                  <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
                    <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="频率" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部频率</SelectItem>
                      <SelectItem value="daily">每日</SelectItem>
                      <SelectItem value="weekly">每周</SelectItem>
                      <SelectItem value="monthly">每月</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
                    <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="状态" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="sent">成功</SelectItem>
                      <SelectItem value="failed">失败</SelectItem>
                      <SelectItem value="missing">缺失</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input placeholder="邮箱筛选" value={ledgerEmail} onChange={e => setLedgerEmail(e.target.value)} className="w-[200px] h-9" />
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" onClick={loadLedger} disabled={ledgerLoading}>
                      {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                      刷新台账
                    </Button>
                  </div>
                </div>

                {ledgerSummary && (
                  <div className="grid gap-3 md:grid-cols-5">
                    <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">应发</div><div className="text-xl font-semibold">{ledgerSummary.expected}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">成功</div><div className="text-xl font-semibold text-emerald-600">{ledgerSummary.sent}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">失败</div><div className="text-xl font-semibold text-destructive">{ledgerSummary.failed}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">缺失</div><div className="text-xl font-semibold text-amber-600">{ledgerSummary.missing}</div></div>
                    <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">可补发</div><div className="text-xl font-semibold">{ledgerSummary.resendable}</div></div>
                  </div>
                )}

                {ledgerError && <p className="text-sm text-destructive">{ledgerError}</p>}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>应发时间</TableHead>
                      <TableHead>频率</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>国家</TableHead>
                      <TableHead>邮箱</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>截图</TableHead>
                      <TableHead>AI 文案</TableHead>
                      <TableHead>错误信息</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledgerItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                          {ledgerLoading ? '台账加载中...' : '暂无台账记录，点击"刷新台账"生成'}
                        </TableCell>
                      </TableRow>
                    ) : ledgerItems.map(item => {
                      const projectLabel = item.project_names?.length ? item.project_names.join(', ') : item.project_ids
                      return (
                        <TableRow key={item.ledger_key}>
                          <TableCell>{new Date(item.expected_at).toLocaleString('zh-CN')}</TableCell>
                          <TableCell><Badge className={cn('text-xs', FREQUENCY_COLORS[item.frequency])}>{FREQUENCY_LABELS[item.frequency]}</Badge></TableCell>
                          <TableCell><span className="text-muted-foreground truncate max-w-[120px] block" title={projectLabel}>{projectLabel}</span></TableCell>
                          <TableCell className="text-muted-foreground">{item.country}</TableCell>
                          <TableCell><span className="text-muted-foreground truncate max-w-[140px] block" title={item.email}>{item.email}</span></TableCell>
                          <TableCell>
                            {item.status === 'sent' ? <span className="text-emerald-600">✓ 成功</span> : item.status === 'failed' ? <span className="text-destructive">✗ 失败</span> : <span className="text-amber-600 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" />缺失</span>}
                          </TableCell>
                          <TableCell>
                            {item.screenshot_r2_thumb_url ? (
                              <button
                                type="button"
                                className="relative h-10 w-10 overflow-hidden rounded border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow"
                                onClick={() => setPreviewScreenshotUrl(item.screenshot_r2_url)}
                                title="点击查看完整图"
                              >
                                <Image src={item.screenshot_r2_thumb_url} alt="报告截图" fill className="object-cover" unoptimized />
                              </button>
                            ) : (
                              <span className="text-muted-foreground text-xs flex items-center gap-1"><ImageIcon className="h-4 w-4" />无</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {item.ai_summary ? (
                              <button
                                type="button"
                                className="flex items-center gap-1 text-xs text-[hsl(var(--chart-2))] hover:underline"
                                onClick={() => setPreviewSummary(item.ai_summary)}
                              >
                                <FileText className="h-4 w-4" />
                                查看
                              </button>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs max-w-[120px] truncate" title={item.error_message || ''}>{item.error_message || '—'}</TableCell>
                          <TableCell>
                            {item.can_resend ? (
                              resendingStates[item.ledger_key] ? (
                                <div className="flex items-center gap-2">
                                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                  <span className={cn("text-xs", RESEND_STAGE_COLORS[resendingStates[item.ledger_key]])}>
                                    {RESEND_STAGE_LABELS[resendingStates[item.ledger_key]]}
                                  </span>
                                </div>
                              ) : (
                                <Button size="sm" variant="outline" onClick={() => handleResendLedger(item)}>
                                  <RotateCcw className="mr-1 h-3 w-3" />
                                  {item.status === 'failed' ? '重试' : '补发'}
                                </Button>
                              )
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {previewScreenshotUrl && (
        <PortraitScreenshotDialog
          open
          onOpenChange={(open) => !open && setPreviewScreenshotUrl(null)}
          src={previewScreenshotUrl}
          alt="报告截图"
        />
      )}

      {previewSummary ? (
        <Dialog open onOpenChange={() => setPreviewSummary(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-[hsl(var(--chart-2))]">报表总结</h3>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(previewSummary)
                  setPreviewSummary(null)
                }}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[hsl(var(--chart-2))] text-white hover:opacity-90 transition-opacity"
              >
                <Copy className="h-4 w-4" />
                复制文案
              </button>
            </div>
            <div className="flex-1 overflow-y-auto text-sm text-foreground leading-relaxed
              prose prose-sm prose-neutral dark:prose-invert max-w-none
              prose-headings:text-base prose-p:text-sm prose-ul:text-sm prose-li:text-sm
              [&_ul]:my-1 [&_p]:my-1 [&_strong]:font-semibold [&_h2]:font-semibold [&_h2]:text-base">
              <ReactMarkdown>{previewSummary}</ReactMarkdown>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* 新增订阅 Dialog */}
      <CreateSubscriptionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        allowedHourOptions={allowedHourOptions}
        isMondayRestricted={isMondayRestricted}
      />

      {/* 编辑订阅 Dialog */}
      <EditSubscriptionDialog
        subscription={editingSub}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        allowedHourOptions={allowedHourOptions}
        isMondayRestricted={isMondayRestricted}
      />
    </>
  )
}