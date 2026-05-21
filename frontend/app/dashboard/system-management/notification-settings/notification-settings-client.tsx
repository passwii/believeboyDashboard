'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Plus, Trash2, Mail, Calendar, ChevronUp, ChevronDown } from 'lucide-react'
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

export function NotificationSettingsClient() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([])
  const [selectedProject, setSelectedProject] = useState<number | null>(null)
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('subscriptions')
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    rule_name: '',
    frequency: 'daily' as Frequency,
    recipients: [] as string[],
    recipientInput: '',
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
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  告警管理功能暂未实现
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}