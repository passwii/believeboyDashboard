'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Trash2, Mail, Calendar, ChevronUp, ChevronDown } from 'lucide-react'
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
  created_at: string
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
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [testingEmail, setTestingEmail] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

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
        body: JSON.stringify({ email: formEmail, project_ids: formProjectIds, country: formCountry, frequency: formFrequency }),
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
        body: JSON.stringify({ email: formEmail, frequency: formFrequency }),
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">定时报告推送</h1>
          <p className="text-sm text-muted-foreground mt-1">配置每日/每周/每月自动推送运营报告到邮箱</p>
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
                <Select value={formFrequency} onValueChange={v => setFormFrequency(v as Frequency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">每日（每天下午 3 点）</SelectItem>
                    <SelectItem value="weekly">每周（每周二上午 10 点）</SelectItem>
                    <SelectItem value="monthly">每月（每月 4 日上午 10 点）</SelectItem>
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
        <CardHeader>
          <CardTitle className="text-base">订阅列表</CardTitle>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无订阅配置，点击上方按钮添加</p>
          ) : (
            <div className="space-y-3">
              {subscriptions.map(sub => (
                <div key={sub.id} className="flex items-center gap-4 p-3 rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))]">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{sub.email}</span>
                      <Badge className={cn('text-xs shrink-0', FREQUENCY_COLORS[sub.frequency])}>
                        <Calendar className="mr-0.5 h-3 w-3" />
                        {FREQUENCY_LABELS[sub.frequency]}
                      </Badge>
                      {sub.enabled ? (
                        <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200 shrink-0">启用</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">已暂停</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {sub.country} · {sub.project_ids === '*' ? '全部项目' : `项目: ${sub.project_ids}`} · 创建于 {new Date(sub.created_at).toLocaleDateString('zh-CN')}
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

      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardHeader>
          <CardTitle className="text-base">推送日志</CardTitle>
        </CardHeader>
        <CardContent>
          {deliveryLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无推送记录</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">时间</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">频率</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">邮箱</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">状态</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground">错误信息</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveryLogs.map(log => (
                    <tr key={log.id} className="border-b border-border/30">
                      <td className="py-2 px-3">{new Date(log.created_at).toLocaleString('zh-CN')}</td>
                      <td className="py-2 px-3">
                        <Badge className={cn('text-xs', FREQUENCY_COLORS[log.frequency])}>{FREQUENCY_LABELS[log.frequency]}</Badge>
                      </td>
                      <td className="py-2 px-3 text-muted-foreground">{log.email}</td>
                      <td className="py-2 px-3">
                        {log.status === 'sent' ? (
                          <span className="text-emerald-600">✓ 成功</span>
                        ) : log.status === 'failed' ? (
                          <span className="text-destructive">✗ 失败</span>
                        ) : (
                          <span className="text-muted-foreground">⏳ 进行中</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">{log.error_message || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
