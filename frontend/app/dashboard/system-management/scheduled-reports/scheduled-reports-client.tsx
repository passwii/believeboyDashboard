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
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Plus, Trash2, Mail, Calendar, ChevronUp, ChevronDown, ImageIcon, Copy, FileText, RotateCcw, AlertTriangle } from 'lucide-react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

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
  ai_model: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}
type DeliveryLog = {
  id: number
  subscription_id: number
  frequency: Frequency
  report_date: string
  report_month: string | null
  email: string
  status: string
  error_message: string | null
  sent_at: string | null
  screenshot_r2_key: string | null
  screenshot_r2_url: string | null
  ai_summary: string | null
  created_at: string
}

type LedgerStatus = 'sent' | 'failed' | 'missing'
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
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLog[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formEmail, setFormEmail] = useState('')
  const [formProjectIds, setFormProjectIds] = useState('*')
  const [formCountry, setFormCountry] = useState('US')
  const [formFrequency, setFormFrequency] = useState<Frequency>('daily')
  const [formDispatchHour, setFormDispatchHour] = useState(15)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [testingEmail, setTestingEmail] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [formAiModel, setFormAiModel] = useState('')
  const [previewScreenshotUrl, setPreviewScreenshotUrl] = useState<string | null>(null)
  const [previewSummary, setPreviewSummary] = useState<string | null>(null)
  const [filterFrequency, setFilterFrequency] = useState<string>('all')
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 30)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [ledgerStartDate, setLedgerStartDate] = useState(thirtyDaysAgo.toISOString().slice(0, 10))
  const [ledgerEndDate, setLedgerEndDate] = useState(today.toISOString().slice(0, 10))
  const [ledgerFrequency, setLedgerFrequency] = useState<string>('all')
  const [ledgerStatus, setLedgerStatus] = useState<string>('all')
  const [ledgerEmail, setLedgerEmail] = useState('')
  const [resendingKey, setResendingKey] = useState<string | null>(null)

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
        const [subRes, logRes, projectData] = await Promise.all([
          fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), { headers: authHeaders() }),
          fetch(resolveApiUrl('/api/v1/scheduled-reports/delivery-logs?limit=20'), { headers: authHeaders() }),
          fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
        ])
        const subs = subRes.ok ? await subRes.json() : { items: [] }
        const logs = logRes.ok ? await logRes.json() : { items: [] }
        setSubscriptions(subs.items || [])
        setDeliveryLogs(logs.items || [])
        setProjects(projectData.filter(p => typeof p.name === 'string' && p.name.trim()))
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [session])

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
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency, dispatch_hour: formDispatchHour, ai_model: formAiModel || null }),
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
      setFormAiModel(modelConfig?.defaultModel || '')
    } catch (e) {
      setFormError(normalizeErrorMessage(e, '创建失败'))
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此订阅？')) return
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
    if (!confirm(`确认${actionLabel} ${item.expected_date} 的 ${FREQUENCY_LABELS[item.frequency]} 报告？`)) return
    setResendingKey(item.ledger_key)
    try {
      const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(item.ledger_key)}/resend`), {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(await res.text())
      await loadLedger()
    } catch (e) {
      alert(normalizeErrorMessage(e, `${actionLabel}失败`))
    } finally {
      setResendingKey(null)
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
          <TabsTrigger value="logs">推送日志</TabsTrigger>
          <TabsTrigger value="preview">报告预览</TabsTrigger>
          <TabsTrigger value="ledger">台账补发</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium">订阅列表</h2>
                <p className="text-sm text-muted-foreground">配置每日/每周/每月自动推送运营报告到邮箱</p>
              </div>
              <Button onClick={() => setShowForm(!showForm)}>
                <Plus className="mr-1 h-4 w-4" />新增订阅
              </Button>
            </div>

            {showForm && (
              <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
                <CardHeader className="pb-4">
                  <CardTitle className="text-base">新增订阅</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
                      <Select value={formFrequency} onValueChange={v => setFormFrequency(v as Frequency)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">每日</SelectItem>
                          <SelectItem value="weekly">每周</SelectItem>
                          <SelectItem value="monthly">每月</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">发送时间（北京时间）</label>
                      <Select value={String(formDispatchHour)} onValueChange={v => setFormDispatchHour(Number(v))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-[240px]">
                          {Array.from({ length: 24 }, (_, i) => (
                            <SelectItem key={i} value={String(i)}>{i.toString().padStart(2, '0')}:00</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                              {modelConfig?.premiumModels.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                          {(modelConfig?.basicModels.length || 0) > 0 && (
                            <SelectGroup>
                              <SelectLabel>基础模型</SelectLabel>
                              {modelConfig?.basicModels.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                          {modelConfig?.models
                            .filter((m) => !modelConfig.premiumModels.includes(m) && !modelConfig.basicModels.includes(m))
                            .map((m) => (
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
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleTestEmail} disabled={testingEmail || !formEmail}>
                      {testingEmail ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Mail className="mr-1 h-4 w-4" />}
                      发送测试邮件
                    </Button>
                    <Button onClick={handleCreate} disabled={formSubmitting}>
                      {formSubmitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      确认创建
                    </Button>
                    <Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-0">
                {subscriptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">暂无订阅配置，点击上方按钮添加</p>
                ) : (
                  <div className="space-y-3 p-4">
                    {subscriptions.map(sub => (
                      <div key={sub.id} className="flex items-center gap-4 p-3 rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))]">
                        <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate">{sub.email}</span>
                              <Badge className={cn('text-xs shrink-0', FREQUENCY_COLORS[sub.frequency])}>
                                <Calendar className="mr-0.5 h-3 w-3" />
                                {FREQUENCY_LABELS[sub.frequency]} · {sub.dispatch_hour.toString().padStart(2, '0')}:00
                              </Badge>
                            {sub.enabled ? (
                              <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200 shrink-0">启用</Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">已暂停</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {(() => {
                              const names = resolveProjectNames(sub.project_ids, projects)
                              const { display, full } = formatProjectNames(names)
                              return (
                                <span title={full}>
                                  {sub.country} · {display} · {sub.dispatch_hour.toString().padStart(2, '0')}:00 发送{sub.ai_model ? ` · 模型: ${sub.ai_model}` : ''} · 创建于 {new Date(sub.created_at).toLocaleDateString('zh-CN')}
                                </span>
                              )
                            })()}
                          </p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button size="sm" variant="ghost" onClick={() => handleToggle(sub)}>
                            {sub.enabled ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDelete(sub.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="logs">
          <div className="space-y-4">
            <h2 className="text-lg font-medium">推送日志</h2>
            <div className="flex items-center gap-4 mb-4">
              <Select value={filterFrequency} onValueChange={setFilterFrequency}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="筛选频率" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部频率</SelectItem>
                  <SelectItem value="daily">每日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                  <SelectItem value="monthly">每月</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-0">
                {deliveryLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">暂无推送记录</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/60">
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">时间</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">频率</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">国家</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">项目</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">邮箱</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">状态</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">截图</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">总结</th>
                          <th className="text-left py-3 px-4 font-medium text-muted-foreground">错误信息</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveryLogs
                          .filter(log => filterFrequency === 'all' || log.frequency === filterFrequency)
                          .map(log => {
                            const sub = subscriptions.find(s => s.id === log.subscription_id)
                            const subProjectNames = sub ? resolveProjectNames(sub.project_ids, projects) : []
                            const { display: projectDisplay, full: projectFull } = formatProjectNames(subProjectNames)
                            const country = sub?.country || '—'
                            return (
                            <tr key={log.id} className="border-b border-border/30">
                              <td className="py-3 px-4">{new Date(log.created_at).toLocaleString('zh-CN')}</td>
                              <td className="py-3 px-4">
                                <Badge className={cn('text-xs', FREQUENCY_COLORS[log.frequency as Frequency])}>{FREQUENCY_LABELS[log.frequency as Frequency]}</Badge>
                              </td>
                              <td className="py-3 px-4 text-muted-foreground">{country}</td>
                              <td className="py-3 px-4">
                                {subProjectNames.length > 0 ? (
                                  <span className="text-muted-foreground truncate max-w-[120px] block" title={projectFull}>
                                    {projectDisplay}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="py-3 px-4 text-muted-foreground">{log.email}</td>
                              <td className="py-3 px-4">
                                {log.status === 'sent' ? (
                                  <span className="text-emerald-600">✓ 成功</span>
                                ) : log.status === 'failed' ? (
                                  <span className="text-destructive">✗ 失败</span>
                                ) : (
                                  <span className="text-muted-foreground">⏳ 进行中</span>
                                )}
                              </td>
                              <td className="py-3 px-4">
                                {log.screenshot_r2_url ? (
                                  <button
                                    type="button"
                                    className="relative h-10 w-10 overflow-hidden rounded border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow"
                                    onClick={() => setPreviewScreenshotUrl(log.screenshot_r2_url)}
                                  >
                                    <Image
                                      src={log.screenshot_r2_url}
                                      alt="报告截图"
                                      fill
                                      className="object-cover"
                                      unoptimized
                                    />
                                  </button>
                                ) : (
                                  <span className="text-muted-foreground text-xs flex items-center gap-1">
                                    <ImageIcon className="h-4 w-4" />
                                    无截图
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-4">
                                {log.ai_summary ? (
                                  <button
                                    type="button"
                                    className="flex items-center gap-1 text-xs text-[hsl(var(--chart-2))] hover:underline"
                                    onClick={() => setPreviewSummary(log.ai_summary)}
                                  >
                                    <FileText className="h-4 w-4" />
                                    查看文案
                                  </button>
                                ) : (
                                  <span className="text-muted-foreground text-xs">—</span>
                                )}
                              </td>
                              <td className="py-3 px-4 text-muted-foreground text-xs">{log.error_message || '—'}</td>
                            </tr>
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

        <TabsContent value="preview">
          <div className="space-y-4">
            <h2 className="text-lg font-medium">报告预览</h2>
            <p className="text-sm text-muted-foreground">查看已发送的报告截图与文案</p>

            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-0">
                {deliveryLogs.filter(log => log.screenshot_r2_url).length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">暂无报告截图</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
                    {deliveryLogs
                      .filter(log => log.screenshot_r2_url)
                      .map(log => {
                        const sub = subscriptions.find(s => s.id === log.subscription_id)
                        const subProjectNames = sub ? resolveProjectNames(sub.project_ids, projects) : []
                        const { display: projectDisplay, full: projectFull } = formatProjectNames(subProjectNames)
                        const country = sub?.country || '—'
                        return (
                        <div key={log.id} className="border border-border/60 rounded-lg overflow-hidden bg-[hsl(var(--surface-subtle))]">
                          <button
                            type="button"
                            className="relative aspect-[4/3] w-full overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => setPreviewScreenshotUrl(log.screenshot_r2_url)}
                          >
                            <Image
                              src={log.screenshot_r2_url!}
                              alt="报告截图"
                              fill
                              className="object-contain"
                              unoptimized
                            />
                          </button>
                          <div className="p-3 border-t border-border/30">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge className={cn('text-xs', FREQUENCY_COLORS[log.frequency as Frequency])}>
                                {FREQUENCY_LABELS[log.frequency as Frequency]}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{log.report_date}</span>
                            </div>

                            <p className="text-xs text-muted-foreground truncate" title={projectFull}>
                              {projectDisplay} · {country}
                            </p>

                            {log.ai_summary ? (
                              <div className="mt-2 space-y-1.5">
                                <div className="flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--chart-2))]">
                                  <FileText className="h-3.5 w-3.5" />
                                  报表总结
                                </div>
                                <div className="text-xs text-muted-foreground leading-relaxed max-h-24 overflow-y-auto
                                  prose prose-sm prose-neutral dark:prose-invert max-w-none
                                  prose-headings:text-xs prose-p:text-xs prose-ul:text-xs prose-li:text-xs
                                  [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold">
                                  <ReactMarkdown>{log.ai_summary}</ReactMarkdown>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigator.clipboard.writeText(log.ai_summary || '')
                                    setCopiedId(log.id)
                                    setTimeout(() => setCopiedId(null), 2000)
                                  }}
                                  className="flex items-center gap-1 text-xs text-[hsl(var(--chart-2))] hover:underline"
                                >
                                  <Copy className="h-3 w-3" />
                                  {copiedId === log.id ? '已复制' : '复制文案'}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        )
                      })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ledger">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-medium">台账补发</h2>
                <p className="text-sm text-muted-foreground">按应发记录检查缺失和失败的定期报告，并支持补发/重试。</p>
              </div>
              <Button onClick={loadLedger} disabled={ledgerLoading}>
                {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                刷新台账
              </Button>
            </div>

            <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
              <CardContent className="p-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-5">
                  <Input type="date" value={ledgerStartDate} onChange={e => setLedgerStartDate(e.target.value)} />
                  <Input type="date" value={ledgerEndDate} onChange={e => setLedgerEndDate(e.target.value)} />
                  <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部频率</SelectItem>
                      <SelectItem value="daily">每日</SelectItem>
                      <SelectItem value="weekly">每周</SelectItem>
                      <SelectItem value="monthly">每月</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="sent">成功</SelectItem>
                      <SelectItem value="failed">失败</SelectItem>
                      <SelectItem value="missing">缺失</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input placeholder="邮箱筛选" value={ledgerEmail} onChange={e => setLedgerEmail(e.target.value)} />
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
                      <TableHead>记录</TableHead>
                      <TableHead>错误信息</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledgerItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          {ledgerLoading ? '台账加载中...' : '暂无台账记录，点击"刷新台账"生成'}
                        </TableCell>
                      </TableRow>
                    ) : ledgerItems.map(item => {
                      const projectLabel = item.project_names?.length ? item.project_names.join(', ') : item.project_ids
                      return (
                        <TableRow key={item.ledger_key}>
                          <TableCell>{new Date(item.expected_at).toLocaleString('zh-CN')}</TableCell>
                          <TableCell><Badge className={cn('text-xs', FREQUENCY_COLORS[item.frequency])}>{FREQUENCY_LABELS[item.frequency]}</Badge></TableCell>
                          <TableCell><span className="text-muted-foreground truncate max-w-[140px] block" title={projectLabel}>{projectLabel}</span></TableCell>
                          <TableCell className="text-muted-foreground">{item.country}</TableCell>
                          <TableCell className="text-muted-foreground">{item.email}</TableCell>
                          <TableCell>
                            {item.status === 'sent' ? <span className="text-emerald-600">✓ 成功</span> : item.status === 'failed' ? <span className="text-destructive">✗ 失败</span> : <span className="text-amber-600 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" />缺失</span>}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{item.latest_delivery_log_id ? `#${item.latest_delivery_log_id}` : '—'}</TableCell>
                          <TableCell className="text-muted-foreground text-xs max-w-[180px] truncate" title={item.error_message || ''}>{item.error_message || '—'}</TableCell>
                          <TableCell>
                            {item.can_resend ? (
                              <Button size="sm" variant="outline" onClick={() => handleResendLedger(item)} disabled={resendingKey === item.ledger_key}>
                                {resendingKey === item.ledger_key ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RotateCcw className="mr-1 h-3 w-3" />}
                                {item.status === 'failed' ? '重试' : '补发'}
                              </Button>
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

      {previewScreenshotUrl ? (
        <Dialog open onOpenChange={() => setPreviewScreenshotUrl(null)}>
          <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
            <div className="relative flex-1 min-h-0">
              <Image
                src={previewScreenshotUrl}
                alt="报告截图"
                fill
                className="object-contain"
                unoptimized
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

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
    </>
  )
}
