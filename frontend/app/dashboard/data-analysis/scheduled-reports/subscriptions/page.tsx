'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Plus, Power, Pencil, Trash2, Inbox } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import { useConfirm } from '@/hooks/use-confirm'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import type { Frequency, Subscription, AIModelConfig } from '../_components/types'
import {
  authHeaders,
  fetchModelConfig,
  resolveApiUrl,
  resolveProjectNames,
  formatProjectNames,
  deleteSubscription,
  toggleSubscription,
} from '../_components/api'
import { CreateSubscriptionDialog } from '../_components/CreateSubscriptionDialog'
import { EditSubscriptionDialog } from '../_components/EditSubscriptionDialog'

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

export default function SubscriptionsPage() {
  const { data: session } = useSession()
  const { confirm } = useConfirm()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSub, setEditingSub] = useState<Subscription | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [filterFrequency, setFilterFrequency] = useState<string>('all')
  const [filterProject, setFilterProject] = useState<string>('all')
  const [filterEmail, setFilterEmail] = useState<string>('')
  const [filterCountry, setFilterCountry] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const initialLoadDone = useRef(false)

  // 加载模型配置
  useEffect(() => {
    fetchModelConfig(
      (cfg) => { setModelConfig(cfg); setIsLoadingModelConfig(false) },
    )
    setIsLoadingModelConfig(true)
  }, [])

  const refreshSubscriptions = useCallback(async () => {
    try {
      const [subRes, projectData] = await Promise.all([
        fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), { headers: authHeaders() }),
        fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
      ])
      const subs = subRes.ok ? await subRes.json() : { items: [] }
      setSubscriptions(subs.items || [])
      setProjects(projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim()))
    } catch (e) {
      console.error(e)
    }
  }, [session])

  useEffect(() => {
    const loadData = async () => {
      const isInitial = !initialLoadDone.current
      if (isInitial) setLoading(true)
      try {
        const [subRes, projectData] = await Promise.all([
          fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), { headers: authHeaders() }),
          fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
        ])
        const subs = subRes.ok ? await subRes.json() : { items: [] }
        setSubscriptions(subs.items || [])
        setProjects(projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim()))
      } catch (e) {
        console.error(e)
      } finally {
        if (isInitial) {
          setLoading(false)
          initialLoadDone.current = true
        }
      }
    }
    void loadData()
  }, [session])

  // 过滤后的订阅列表
  const filteredSubscriptions = subscriptions.filter(sub => {
    if (filterFrequency !== 'all' && sub.frequency !== filterFrequency) return false
    if (filterProject !== 'all') {
      const ids = sub.project_ids === '*' ? [] : sub.project_ids.split(',').map(id => id.trim())
      if (!ids.includes(filterProject)) return false
    }
    if (filterEmail.trim() && !(sub.email || '').toLowerCase().includes(filterEmail.toLowerCase())) return false
    if (filterCountry !== 'all') {
      const subCountries = sub.country.split(',').map(c => c.trim().toUpperCase())
      if (!subCountries.includes(filterCountry.toUpperCase())) return false
    }
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
    const ok = await deleteSubscription(id)
    if (ok) {
      setSubscriptions(prev => prev.filter(s => s.id !== id))
    }
  }

  const handleToggle = async (sub: Subscription) => {
    const result = await toggleSubscription(sub.id, !sub.enabled)
    if (result.ok) {
      setSubscriptions(prev => prev.map(s => s.id === sub.id ? { ...s, enabled: !s.enabled } : s))
    }
  }

  const roleType = session?.user?.roleType
  const canManage = roleType === 'admin' || roleType === 'operator'

  if (loading) {
    return (
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-4">
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-0">
          {/* 工具栏 */}
          <div className="p-4 border-b border-border/60">
            {/* 桌面端 */}
            <div className="hidden md:flex gap-3 flex-wrap items-center">
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
                  {COUNTRY_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
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
              <div className="ml-auto">
                {canManage && (
                  <Button size="sm" onClick={() => setShowCreateDialog(true)}>
                    <Plus className="mr-1 h-4 w-4" />新增订阅
                  </Button>
                )}
              </div>
            </div>
            {/* 手机端 */}
            <div className="md:hidden grid grid-cols-2 gap-2">
              <Select value={filterFrequency} onValueChange={setFilterFrequency}>
                <SelectTrigger className="h-9"><SelectValue placeholder="频率" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="daily">每日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                  <SelectItem value="monthly">每月</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterProject} onValueChange={setFilterProject}>
                <SelectTrigger className="h-9"><SelectValue placeholder="项目" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部项目</SelectItem>
                  {projects.map(p => (
                    <SelectItem key={p.id?.toString() || p.name} value={p.id?.toString() || ''}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterCountry} onValueChange={setFilterCountry}>
                <SelectTrigger className="h-9"><SelectValue placeholder="国家" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部国家</SelectItem>
                  {COUNTRY_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-9"><SelectValue placeholder="状态" /></SelectTrigger>
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
                className="col-span-2 h-9"
              />
              <div className="col-span-2">
                {canManage && (
                  <Button size="sm" className="w-full" onClick={() => setShowCreateDialog(true)}>
                    <Plus className="mr-1 h-4 w-4" />新增订阅
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* 订阅列表 */}
          {subscriptions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">暂无订阅配置</p>
              <p className="text-xs text-muted-foreground/60 mb-4">
                {canManage ? '点击上方「新增订阅」按钮创建第一个配置' : '暂无可用订阅配置'}
              </p>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setShowCreateDialog(true)}>
                  <Plus className="mr-1 h-4 w-4" />新增订阅
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* 桌面端表格 */}
              <div className="hidden md:block overflow-x-auto">
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
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {sub.country.split(',').map(c => c.trim()).filter(Boolean).map(c => (
                                <Badge key={c} variant="secondary" className="text-xs">{getCountryLabel(c)}</Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={cn('text-xs', FREQUENCY_COLORS[sub.frequency])}>
                              {FREQUENCY_LABELS[sub.frequency]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {sub.dispatch_hour.toString().padStart(2, '0')}:{sub.dispatch_minute.toString().padStart(2, '0')}{weekdayLabel}{dayLabel}
                          </TableCell>
                          <TableCell>
                            <span className="text-muted-foreground truncate max-w-[160px] block" title={sub.email || ''}>
                              {sub.email || <span className="italic text-muted-foreground/70">未填写</span>}
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
                              {canManage && (
                                <>
                                  <Button size="sm" variant="ghost" onClick={() => handleToggle(sub)} title={sub.enabled ? '暂停' : '启用'}>
                                    <Power className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => handleEdit(sub)}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDelete(sub.id)}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* 手机端卡片列表 */}
              <div className="md:hidden divide-y divide-border/60">
                {filteredSubscriptions.map(sub => {
                  const names = resolveProjectNames(sub.project_ids, projects)
                  const { display, full } = formatProjectNames(names)
                  const weekdayLabel = sub.frequency === 'weekly' ? ` 周${['一','二','三','四','五','六','日'][sub.dispatch_weekday ?? 0]}` : ''
                  const dayLabel = sub.frequency === 'monthly' ? ` ${sub.dispatch_day ?? 2}日` : ''
                  return (
                    <div key={sub.id} className="p-4">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate" title={full}>{display}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {sub.dispatch_hour.toString().padStart(2, '0')}:{sub.dispatch_minute.toString().padStart(2, '0')}{weekdayLabel}{dayLabel}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge className={cn('text-xs', FREQUENCY_COLORS[sub.frequency])}>
                            {FREQUENCY_LABELS[sub.frequency]}
                          </Badge>
                          {sub.enabled ? (
                            <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200">启用</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs text-muted-foreground">已暂停</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1 mb-3">
                        {sub.country.split(',').map(c => c.trim()).filter(Boolean).map(c => (
                          <Badge key={c} variant="secondary" className="text-xs">{getCountryLabel(c)}</Badge>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground mb-3 truncate" title={sub.email || ''}>{sub.email || '未填写邮箱'}</div>
                      {sub.ai_model && <div className="text-xs text-muted-foreground mb-3">AI: {sub.ai_model}</div>}
                      <div className="flex gap-2">
                        {canManage && (
                          <>
                            <Button size="sm" variant="outline" className="flex-1" onClick={() => handleToggle(sub)}>
                              <Power className="h-4 w-4 mr-1" />{sub.enabled ? '暂停' : '启用'}
                            </Button>
                            <Button size="sm" variant="outline" className="flex-1" onClick={() => handleEdit(sub)}>
                              <Pencil className="h-4 w-4 mr-1" />编辑
                            </Button>
                            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive min-w-[44px]" onClick={() => handleDelete(sub.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CreateSubscriptionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        onSuccess={refreshSubscriptions}
      />

      <EditSubscriptionDialog
        subscription={editingSub}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        onSuccess={refreshSubscriptions}
      />
    </div>
  )
}
