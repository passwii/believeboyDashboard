'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Trash2, Mail, Calendar, ChevronUp, ChevronDown, Pencil, Bell, Zap } from 'lucide-react'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'

type Frequency = 'daily' | 'weekly' | 'monthly'
type Subscription = {
  id: number
  project_id: number
  rule_name: string
  frequency: Frequency
  report_types: string[]
  recipients: string[]
  enabled: boolean
  created_at: string
}

type AlertMetric = {
  value: string
  label: string
  description: string
}

type AlertRule = {
  id: number
  project_id: number
  country: string
  metric: string
  condition: string
  threshold: number
  window_days: number
  severity: string
  is_active: boolean
  created_by: string
  created_at: string
  updated_at: string
}

type AlertEvent = {
  id: number
  rule_id: number
  project_id: number
  metric: string
  current_value: number
  baseline_value: number
  deviation_pct: number
  severity: string
  message: string
  status: string
  triggered_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
}

type AlertRuleFormData = {
  country: string
  metric: string
  condition: string
  threshold: string
  window_days: string
  severity: string
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

const CONDITION_LABELS: Record<string, string> = {
  below: '低于',
  above: '高于',
  drop_pct: '下降超过',
  rise_pct: '上涨超过',
}

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

const SEVERITY_LABELS: Record<string, string> = {
  info: '信息',
  warning: '警告',
  critical: '严重',
}

export function NotificationSettingsClient() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([])
  const [selectedProject, setSelectedProject] = useState<number | null>(null)
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [alertRules, setAlertRules] = useState<AlertRule[]>([])
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([])
  const [metrics, setMetrics] = useState<AlertMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('subscriptions')
  const [showForm, setShowForm] = useState(false)
  const [showAlertForm, setShowAlertForm] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)
  const [formData, setFormData] = useState({
    rule_name: '',
    frequency: 'daily' as Frequency,
    recipients: [] as string[],
    recipientInput: '',
  })
  const [alertFormData, setAlertFormData] = useState<AlertRuleFormData>({
    country: 'US',
    metric: '',
    condition: 'below',
    threshold: '',
    window_days: '7',
    severity: 'warning',
  })

  useEffect(() => {
    const loadProjects = async () => {
      const data = await fetchManagedProjectsCached<Array<{ id: number; name: string }>>(session)
      const validProjects = data.filter(p => p.id && p.name)
      setProjects(validProjects)
      if (validProjects.length > 0 && !selectedProject) {
        setSelectedProject(validProjects[0].id)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    if (!selectedProject) return
    const loadSubscriptions = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API_BASE}/api/v1/notification-settings/subscriptions?project_id=${selectedProject}`)
        const data = await res.json()
        setSubscriptions(data.items || [])
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    void loadSubscriptions()
  }, [selectedProject])

  // Load alert rules and metrics when alert tab is selected
  useEffect(() => {
    if (activeTab !== 'alerts' || !selectedProject) return
    const loadAlertData = async () => {
      setLoading(true)
      try {
        // Load metrics options
        const metricsRes = await fetch(`${API_BASE}/api/v1/alerts/metrics`)
        const metricsData = await metricsRes.json()
        setMetrics(metricsData.metrics || [])

        // Load alert rules
        const rulesRes = await fetch(`${API_BASE}/api/v1/alerts/rules?project_id=${selectedProject}`)
        const rulesData = await rulesRes.json()
        setAlertRules(Array.isArray(rulesData) ? rulesData : [])

        // Load recent alert events
        const eventsRes = await fetch(`${API_BASE}/api/v1/alerts/events?project_id=${selectedProject}&page_size=10`)
        const eventsData = await eventsRes.json()
        setAlertEvents(eventsData.items || [])
      } catch (e) {
        console.error('Failed to load alert data:', e)
      } finally {
        setLoading(false)
      }
    }
    void loadAlertData()
  }, [activeTab, selectedProject])

  const handleCreate = async () => {
    if (!selectedProject || !formData.rule_name.trim()) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/notification-settings/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject,
          rule_name: formData.rule_name,
          frequency: formData.frequency,
          report_types: [],
          recipients: formData.recipients,
        }),
      })
      if (res.ok) {
        const sub = await res.json()
        setSubscriptions(prev => [sub, ...prev])
        setShowForm(false)
        setFormData({ rule_name: '', frequency: 'daily', recipients: [], recipientInput: '' })
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleToggle = async (sub: Subscription) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/notification-settings/subscriptions/${sub.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此规则？')) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/notification-settings/subscriptions/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setSubscriptions(prev => prev.filter(s => s.id !== id))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleTestEmail = async (sub: Subscription) => {
    const email = prompt('输入测试收件人邮箱（留空使用配置中的收件人）:', sub.recipients[0] || '')
    if (email === null) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/notification-settings/subscriptions/${sub.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_recipients: email ? [email] : null }),
      })
      const data = await res.json()
      alert(data.message)
    } catch (e) {
      alert('发送失败')
    }
  }

  const addRecipient = () => {
    if (formData.recipientInput.trim()) {
      setFormData(prev => ({
        ...prev,
        recipients: [...prev.recipients, prev.recipientInput.trim()],
        recipientInput: '',
      }))
    }
  }

  // Alert rule management functions
  const handleCreateAlertRule = async () => {
    if (!selectedProject || !alertFormData.metric || !alertFormData.threshold) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject,
          country: alertFormData.country,
          metric: alertFormData.metric,
          condition: alertFormData.condition,
          threshold: parseFloat(alertFormData.threshold),
          window_days: parseInt(alertFormData.window_days) || 7,
          severity: alertFormData.severity,
        }),
      })
      if (res.ok) {
        const rule = await res.json()
        setAlertRules(prev => [rule, ...prev])
        setShowAlertForm(false)
        resetAlertForm()
      } else {
        const err = await res.json()
        alert(`创建失败: ${err.detail || '未知错误'}`)
      }
    } catch (e) {
      console.error(e)
      alert('创建失败')
    }
  }

  const handleUpdateAlertRule = async () => {
    if (!editingRule || !alertFormData.threshold) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/rules/${editingRule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metric: alertFormData.metric || undefined,
          condition: alertFormData.condition,
          threshold: parseFloat(alertFormData.threshold),
          window_days: parseInt(alertFormData.window_days) || 7,
          severity: alertFormData.severity,
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        setAlertRules(prev => prev.map(r => r.id === editingRule.id ? updated : r))
        setShowAlertForm(false)
        setEditingRule(null)
        resetAlertForm()
      } else {
        const err = await res.json()
        alert(`更新失败: ${err.detail || '未知错误'}`)
      }
    } catch (e) {
      console.error(e)
      alert('更新失败')
    }
  }

  const handleToggleAlertRule = async (rule: AlertRule) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !rule.is_active }),
      })
      if (res.ok) {
        const updated = await res.json()
        setAlertRules(prev => prev.map(r => r.id === rule.id ? updated : r))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleDeleteAlertRule = async (ruleId: number) => {
    if (!confirm('确定删除此告警规则？')) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/rules/${ruleId}`, { method: 'DELETE' })
      if (res.ok) {
        setAlertRules(prev => prev.filter(r => r.id !== ruleId))
      } else {
        const err = await res.json()
        alert(`删除失败: ${err.detail || '未知错误'}`)
      }
    } catch (e) {
      console.error(e)
      alert('删除失败')
    }
  }

  const handleTestAlert = async (rule: AlertRule) => {
    if (!confirm(`测试告警规则"${rule.metric}"？这将根据当前数据立即触发检测。`)) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/detect`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        alert(`检测完成：评估了 ${data.rules_evaluated} 条规则，创建了 ${data.events_created} 个事件，发送了 ${data.messages_sent} 条通知。`)
        // Reload events
        if (selectedProject) {
          const eventsRes = await fetch(`${API_BASE}/api/v1/alerts/events?project_id=${selectedProject}&page_size=10`)
          const eventsData = await eventsRes.json()
          setAlertEvents(eventsData.items || [])
        }
      } else {
        alert(`测试失败: ${data.detail || '未知错误'}`)
      }
    } catch (e) {
      console.error(e)
      alert('测试失败')
    }
  }

  const handleAcknowledgeEvent = async (eventId: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/events/${eventId}/acknowledge`, {
        method: 'POST',
      })
      if (res.ok) {
        const updated = await res.json()
        setAlertEvents(prev => prev.map(e => e.id === eventId ? updated : e))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleResolveEvent = async (eventId: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/alerts/events/${eventId}/resolve`, {
        method: 'POST',
      })
      if (res.ok) {
        const updated = await res.json()
        setAlertEvents(prev => prev.map(e => e.id === eventId ? updated : e))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const resetAlertForm = () => {
    setAlertFormData({
      country: 'US',
      metric: '',
      condition: 'below',
      threshold: '',
      window_days: '7',
      severity: 'warning',
    })
  }

  const openEditAlertForm = (rule: AlertRule) => {
    setEditingRule(rule)
    setAlertFormData({
      country: rule.country,
      metric: rule.metric,
      condition: rule.condition,
      threshold: rule.threshold.toString(),
      window_days: rule.window_days.toString(),
      severity: rule.severity,
    })
    setShowAlertForm(true)
  }

  const getMetricLabel = (metricValue: string) => {
    const found = metrics.find(m => m.value === metricValue)
    return found ? found.label : metricValue
  }

  const formatDatetime = (datetimeStr: string) => {
    const date = new Date(datetimeStr)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">通知设置</h1>
          <p className="text-sm text-muted-foreground mt-1">管理订阅规则和告警规则</p>
        </div>
      </div>

      <div className="flex gap-4">
        <Card className="w-64 shrink-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">项目列表</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedProject(p.id)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                  selectedProject === p.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent'
                )}
              >
                📁 {p.name}
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="flex-1">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex items-center justify-between mb-4">
              <TabsList>
                <TabsTrigger value="subscriptions">📬 订阅管理</TabsTrigger>
                <TabsTrigger value="alerts">🚨 告警管理</TabsTrigger>
              </TabsList>
              {activeTab === 'subscriptions' && selectedProject && (
                <Button size="sm" onClick={() => setShowForm(!showForm)}>
                  <Plus className="mr-1 h-4 w-4" />新建规则
                </Button>
              )}
              {activeTab === 'alerts' && selectedProject && (
                <Button size="sm" variant="outline" onClick={() => handleTestAlert({ id: 0 } as AlertRule)}>
                  <Zap className="mr-1 h-4 w-4" />测试全部
                </Button>
              )}
            </div>

            <TabsContent value="subscriptions">
              {showForm && (
                <Card className="mb-4">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-base">新建订阅规则</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <label className="text-sm font-medium mb-1 block">规则名称</label>
                      <Input
                        placeholder="例如：每日综合日报"
                        value={formData.rule_name}
                        onChange={e => setFormData(prev => ({ ...prev, rule_name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">推送频率</label>
                      <Select
                        value={formData.frequency}
                        onValueChange={v => setFormData(prev => ({ ...prev, frequency: v as Frequency }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">每日（每天下午 3 点）</SelectItem>
                          <SelectItem value="weekly">每周（每周二上午 10 点）</SelectItem>
                          <SelectItem value="monthly">每月（每月 4 日上午 10 点）</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">收件人</label>
                      <div className="flex gap-2 mb-2">
                        <Input
                          placeholder="输入邮箱后回车添加"
                          value={formData.recipientInput}
                          onChange={e => setFormData(prev => ({ ...prev, recipientInput: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addRecipient())}
                        />
                        <Button variant="outline" onClick={addRecipient}>添加</Button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {formData.recipients.map((r, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {r}
                            <button
                              onClick={() => setFormData(prev => ({
                                ...prev,
                                recipients: prev.recipients.filter((_, idx) => idx !== i),
                              }))}
                              className="ml-1 hover:text-destructive"
                            >
                              ×
                            </button>
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={handleCreate}>确认创建</Button>
                      <Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {loading ? (
                <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : subscriptions.length === 0 ? (
                <Card><CardContent className="py-8 text-center text-muted-foreground">暂无订阅规则</CardContent></Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-3 px-4 font-medium">规则名称</th>
                          <th className="text-left py-3 px-4 font-medium">频率</th>
                          <th className="text-left py-3 px-4 font-medium">收件人</th>
                          <th className="text-left py-3 px-4 font-medium">状态</th>
                          <th className="text-left py-3 px-4 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subscriptions.map(sub => (
                          <tr key={sub.id} className="border-b border-border/30">
                            <td className="py-3 px-4 font-medium">{sub.rule_name}</td>
                            <td className="py-3 px-4">
                              <Badge className={FREQUENCY_COLORS[sub.frequency]}>
                                <Calendar className="mr-0.5 h-3 w-3" />
                                {FREQUENCY_LABELS[sub.frequency]}
                              </Badge>
                            </td>
                            <td className="py-3 px-4 text-muted-foreground">{sub.recipients.join(', ')}</td>
                            <td className="py-3 px-4">
                              {sub.enabled ? (
                                <Badge variant="outline" className="text-emerald-600">启用</Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">已暂停</Badge>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex gap-1">
                                <Button size="sm" variant="ghost" onClick={() => handleTestEmail(sub)}>
                                  <Mail className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => handleToggle(sub)}>
                                  {sub.enabled ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                                </Button>
                                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(sub.id)}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="alerts">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {alertRules.length > 0 && (
                    <div className="flex gap-4 text-sm">
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground">{alertRules.filter(r => r.is_active).length}</span> 条活跃规则
                      </span>
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground">{alertEvents.filter(e => e.status === 'active').length}</span> 条未处理事件
                      </span>
                    </div>
                  )}
                </div>
                <Button size="sm" onClick={() => { resetAlertForm(); setShowAlertForm(true) }}>
                  <Plus className="mr-1 h-4 w-4" />新建规则
                </Button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : alertRules.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <Bell className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                    <p className="text-muted-foreground mb-2">暂无告警规则</p>
                    <p className="text-sm text-muted-foreground/70">创建告警规则，当指标异常时自动通知</p>
                    <Button className="mt-4" variant="outline" onClick={() => { resetAlertForm(); setShowAlertForm(true) }}>
                      <Plus className="mr-1 h-4 w-4" />创建第一条规则
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-6">
                  {/* Alert Rules Table */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">告警规则</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-3 px-4 font-medium">规则名称</th>
                            <th className="text-left py-3 px-4 font-medium">指标</th>
                            <th className="text-left py-3 px-4 font-medium">条件</th>
                            <th className="text-left py-3 px-4 font-medium">严重性</th>
                            <th className="text-left py-3 px-4 font-medium">状态</th>
                            <th className="text-left py-3 px-4 font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {alertRules.map(rule => (
                            <tr key={rule.id} className="border-b border-border/30">
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2">
                                  <Zap className="h-4 w-4 text-muted-foreground" />
                                  <span className="font-medium">{getMetricLabel(rule.metric)}</span>
                                </div>
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {rule.country === 'US' ? '美国站' : rule.country === 'DE' ? '德国站' : rule.country === 'UK' ? '英国站' : rule.country}
                                  · 窗口 {rule.window_days} 天
                                </div>
                              </td>
                              <td className="py-3 px-4">
                                <Badge variant="outline">{getMetricLabel(rule.metric)}</Badge>
                              </td>
                              <td className="py-3 px-4">
                                <span className="text-muted-foreground">
                                  {CONDITION_LABELS[rule.condition] || rule.condition}
                                </span>
                                <span className="ml-1 font-medium">
                                  {rule.metric === 'acos' || rule.metric === 'return_rate'
                                    ? `${(rule.threshold * 100).toFixed(1)}%`
                                    : rule.threshold.toLocaleString()}
                                </span>
                              </td>
                              <td className="py-3 px-4">
                                <Badge className={SEVERITY_COLORS[rule.severity] || SEVERITY_COLORS.warning}>
                                  {SEVERITY_LABELS[rule.severity] || rule.severity}
                                </Badge>
                              </td>
                              <td className="py-3 px-4">
                                {rule.is_active ? (
                                  <Badge variant="outline" className="text-emerald-600 bg-emerald-50 dark:bg-emerald-950">启用</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-muted-foreground">已暂停</Badge>
                                )}
                              </td>
                              <td className="py-3 px-4">
                                <div className="flex gap-1">
                                  <Button size="sm" variant="ghost" onClick={() => handleTestAlert(rule)} title="测试告警">
                                    <Zap className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => handleToggleAlertRule(rule)}>
                                    {rule.is_active ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => openEditAlertForm(rule)}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDeleteAlertRule(rule.id)}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>

                  {/* Recent Alert Events */}
                  {alertEvents.length > 0 && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">最近事件</CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-3 px-4 font-medium">时间</th>
                              <th className="text-left py-3 px-4 font-medium">指标</th>
                              <th className="text-left py-3 px-4 font-medium">当前值</th>
                              <th className="text-left py-3 px-4 font-medium">偏离</th>
                              <th className="text-left py-3 px-4 font-medium">状态</th>
                              <th className="text-left py-3 px-4 font-medium">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {alertEvents.map(event => (
                              <tr key={event.id} className="border-b border-border/30">
                                <td className="py-3 px-4 text-muted-foreground text-xs">
                                  {formatDatetime(event.triggered_at)}
                                </td>
                                <td className="py-3 px-4">
                                  <Badge variant="outline">{getMetricLabel(event.metric)}</Badge>
                                </td>
                                <td className="py-3 px-4 font-medium">
                                  {event.metric === 'acos' || event.metric === 'return_rate'
                                    ? `${(event.current_value * 100).toFixed(1)}%`
                                    : event.current_value.toLocaleString()}
                                </td>
                                <td className="py-3 px-4">
                                  <span className={cn(
                                    'font-medium',
                                    event.deviation_pct > 0 ? 'text-red-600' : 'text-emerald-600'
                                  )}>
                                    {event.deviation_pct > 0 ? '+' : ''}{event.deviation_pct.toFixed(1)}%
                                  </span>
                                </td>
                                <td className="py-3 px-4">
                                  <Badge className={SEVERITY_COLORS[event.severity]}>
                                    {event.status === 'active' ? SEVERITY_LABELS[event.severity] || event.severity : event.status}
                                  </Badge>
                                </td>
                                <td className="py-3 px-4">
                                  <div className="flex gap-1">
                                    {event.status === 'active' && (
                                      <>
                                        <Button size="sm" variant="ghost" onClick={() => handleAcknowledgeEvent(event.id)} title="确认">
                                          <Bell className="h-4 w-4" />
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => handleResolveEvent(event.id)} title="解决">
                                          <ChevronUp className="h-4 w-4" />
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* Alert Rule Form Dialog */}
              <Dialog open={showAlertForm} onOpenChange={(open) => {
                setShowAlertForm(open)
                if (!open) {
                  setEditingRule(null)
                  resetAlertForm()
                }
              }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{editingRule ? '编辑告警规则' : '新建告警规则'}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div>
                      <label className="text-sm font-medium mb-1 block">站点</label>
                      <Select
                        value={alertFormData.country}
                        onValueChange={v => setAlertFormData(prev => ({ ...prev, country: v }))}
                        disabled={!!editingRule}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="US">美国站 (US)</SelectItem>
                          <SelectItem value="DE">德国站 (DE)</SelectItem>
                          <SelectItem value="UK">英国站 (UK)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">监控指标</label>
                      <Select
                        value={alertFormData.metric}
                        onValueChange={v => setAlertFormData(prev => ({ ...prev, metric: v }))}
                      >
                        <SelectTrigger><SelectValue placeholder="选择指标" /></SelectTrigger>
                        <SelectContent>
                          {metrics.map(m => (
                            <SelectItem key={m.value} value={m.value}>
                              {m.label} — {m.description}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">触发条件</label>
                      <Select
                        value={alertFormData.condition}
                        onValueChange={v => setAlertFormData(prev => ({ ...prev, condition: v }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="below">低于阈值</SelectItem>
                          <SelectItem value="above">高于阈值</SelectItem>
                          <SelectItem value="drop_pct">下降超过</SelectItem>
                          <SelectItem value="rise_pct">上涨超过</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">
                        阈值
                        {alertFormData.metric && (
                          <span className="text-muted-foreground font-normal ml-2">
                            ({alertFormData.condition === 'drop_pct' || alertFormData.condition === 'rise_pct' ? '百分比，如 20' : '具体数值'})
                          </span>
                        )}
                      </label>
                      <Input
                        type="number"
                        placeholder={alertFormData.condition === 'drop_pct' || alertFormData.condition === 'rise_pct' ? '20' : '1000'}
                        value={alertFormData.threshold}
                        onChange={e => setAlertFormData(prev => ({ ...prev, threshold: e.target.value }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">时间窗口（天）</label>
                        <Select
                          value={alertFormData.window_days}
                          onValueChange={v => setAlertFormData(prev => ({ ...prev, window_days: v }))}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="3">3 天</SelectItem>
                            <SelectItem value="7">7 天</SelectItem>
                            <SelectItem value="14">14 天</SelectItem>
                            <SelectItem value="30">30 天</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">严重性</label>
                        <Select
                          value={alertFormData.severity}
                          onValueChange={v => setAlertFormData(prev => ({ ...prev, severity: v }))}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="info">信息</SelectItem>
                            <SelectItem value="warning">警告</SelectItem>
                            <SelectItem value="critical">严重</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => { setShowAlertForm(false); setEditingRule(null); resetAlertForm() }}>
                      取消
                    </Button>
                    <Button onClick={editingRule ? handleUpdateAlertRule : handleCreateAlertRule}>
                      {editingRule ? '保存修改' : '创建规则'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}