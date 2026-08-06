'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Loader2, KeyRound, Copy, Check, LayoutGrid, Wrench, BookOpen, Activity } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { ProjectScopeSelect } from '@/components/project-scope-select'
import { MultiSelect, type Option as MultiSelectOption } from '@/components/ui/multi-select'
import { cn } from '@/lib/utils'
import {
  AgentApiKeyItem,
  createAgentApiKey,
  listAgentApiKeys,
  normalizeProjectScope,
  revokeAgentApiKey,
} from '@/lib/api/agent-key-admin'
import {
  AGENT_DOMAINS,
  formatBusinessScope,
  getAgentDomain,
  liveAgentDomains,
  normalizeBusinessScope,
  scopeHasDomain,
} from '@/lib/agent-domains'
import { AgentUsageGuide, buildUsageText, fetchBackendBaseUrl } from './agent-usage-guide'
import { AgentAccessLogsPanel } from '@/components/system/agent-access-logs-panel'
import { AgentOperationLogsPanel } from '@/components/system/agent-operation-logs-panel'

type CreatedResult = {
  plaintext_key: string
  agent_id: string
  label: string
  project_scope: string
  business_scope: string
}

/** 把后端 project_scope 值格式化成可读文案（* = 全部项目；否则映射项目名）。 */
function formatProjectScope(
  scope: string | undefined | null,
  projects: Array<{ id: number; name: string }>
): string {
  const value = normalizeProjectScope(scope)
  if (value === '*') return '全部项目'
  const nameById = new Map(projects.map((p) => [p.id, p.name]))
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => nameById.get(Number(id)) ?? `#${id}`)
    .join('、')
}

export function AgentManagementClient() {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const { projects } = useManagedProjects()
  const [keys, setKeys] = useState<AgentApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [agentId, setAgentId] = useState('')
  const [projectScope, setProjectScope] = useState('*')
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [businessScope, setBusinessScope] = useState('*')
  const [selectedDomainIds, setSelectedDomainIds] = useState<string[]>([])
  const [domainFilter, setDomainFilter] = useState('all')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [usageCopied, setUsageCopied] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await listAgentApiKeys())
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `加载失败：${error.message}` : '加载失败',
      })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const resetForm = useCallback(() => {
    setLabel('')
    setAgentId('')
    setProjectScope('*')
    setSelectedProjectIds([])
    setBusinessScope('*')
    setSelectedDomainIds([])
    setCreated(null)
  }, [])

  const handleCreate = async () => {
    if (!label.trim() || !agentId.trim()) return
    setSubmitting(true)
    try {
      const result = await createAgentApiKey({
        label: label.trim(),
        agent_id: agentId.trim(),
        expires_at: null,
        project_scope: normalizeProjectScope(projectScope),
        business_scope: normalizeBusinessScope(businessScope),
      })
      setCreated({
        plaintext_key: result.plaintext_key,
        agent_id: result.agent_id ?? agentId.trim(),
        label: result.label,
        project_scope: result.project_scope ?? '*',
        business_scope: result.business_scope ?? '*',
      })
      setLabel('')
      setAgentId('')
      setProjectScope('*')
      setSelectedProjectIds([])
      setBusinessScope('*')
      setSelectedDomainIds([])
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `创建失败：${error.message}` : '创建失败',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevoke = async (item: AgentApiKeyItem) => {
    const ok = await confirm({
      title: `吊销凭据「${item.label}」？`,
      description: '吊销后使用该凭据的 Agent 将立即无法访问，且不可恢复。',
      confirmText: '吊销',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await revokeAgentApiKey(item.id)
      notify({ type: 'success', title: `已吊销：${item.label}` })
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `吊销失败：${error.message}` : '吊销失败',
      })
    }
  }

  const copyPlaintext = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.plaintext_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyUsage = async () => {
    if (!created) return
    const baseUrl = await fetchBackendBaseUrl()
    await navigator.clipboard.writeText(
      buildUsageText({
        plaintextKey: created.plaintext_key,
        agentId: created.agent_id,
        baseUrl,
        domain: created.business_scope === '*' ? 'shipments' : created.business_scope.split(',')[0].trim(),
      })
    )
    setUsageCopied(true)
    setTimeout(() => setUsageCopied(false), 2000)
  }

  // ── 凭据管理 Tab 数据（业务域筛选） ──────────────────────────────
  const filteredKeys = useMemo(() => {
    if (domainFilter === 'all') return keys
    return keys.filter((k) => scopeHasDomain(k.business_scope, domainFilter))
  }, [keys, domainFilter])

  // ── 业务域概览 Tab 数据（每域授权凭据数） ────────────────────────
  const domainStats = useMemo(() => {
    return AGENT_DOMAINS.map((domain) => ({
      domain,
      keyCount: keys.filter((k) => scopeHasDomain(k.business_scope, domain.code)).length,
    }))
  }, [keys])

  const domainOptions: MultiSelectOption[] = useMemo(
    () => liveAgentDomains().map((d) => ({ value: d.code, label: d.label })),
    []
  )

  const isBusinessAll = businessScope === '*'
  const handleDomainToggleAll = (checked: boolean) => {
    if (checked) {
      setBusinessScope('*')
      setSelectedDomainIds([])
    } else {
      setBusinessScope(selectedDomainIds.length > 0 ? selectedDomainIds.join(',') : '')
    }
  }
  const handleDomainIdsChange = (next: string[]) => {
    setSelectedDomainIds(next)
    if (next.length === 0) {
      setBusinessScope('')
    } else {
      setBusinessScope(next.join(','))
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Agent 接入管理
        </h1>
        <Button onClick={() => setCreateOpen(true)}>创建凭据</Button>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-muted/25 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
          <TabsTrigger value="overview" className="min-h-10 px-5 py-2 text-sm">
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            业务域概览
          </TabsTrigger>
          <TabsTrigger value="credentials" className="min-h-10 px-5 py-2 text-sm">
            <KeyRound className="mr-1.5 h-4 w-4" />
            凭据管理
          </TabsTrigger>
          <TabsTrigger value="guide" className="min-h-10 px-5 py-2 text-sm">
            <BookOpen className="mr-1.5 h-4 w-4" />
            调用指南
          </TabsTrigger>
          <TabsTrigger value="logs" className="min-h-10 px-5 py-2 text-sm">
            <Activity className="mr-1.5 h-4 w-4" />
            访问日志
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1 业务域概览 ─────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>业务域接入一览</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {domainStats.map(({ domain, keyCount }) => (
                  <div
                    key={domain.code}
                    className={cn(
                      'rounded-xl border p-4',
                      domain.status === 'live'
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-dashed border-border/70 bg-muted/20'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{domain.label}</span>
                      {domain.status === 'live' ? (
                        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                          已接入
                        </Badge>
                      ) : (
                        <Badge variant="secondary">规划中</Badge>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
                      {domain.description}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      {domain.status === 'live' && (
                        <Badge variant="outline">{domain.routeCount} 路由</Badge>
                      )}
                      {domain.capabilities.read && (
                        <Badge variant="outline">读</Badge>
                      )}
                      {domain.capabilities.write && (
                        <Badge variant="outline">写</Badge>
                      )}
                      <span className="ml-auto text-muted-foreground">
                        {domain.status === 'live' ? `${keyCount} 张凭据授权` : '待接入'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2 凭据管理 ───────────────────────────────────────── */}
        <TabsContent value="credentials" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                凭据列表
                <span className="ml-auto flex items-center gap-2">
                  <select
                    value={domainFilter}
                    onChange={(e) => setDomainFilter(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    aria-label="按业务域筛选"
                  >
                    <option value="all">全部业务域</option>
                    {AGENT_DOMAINS.filter((d) => d.status === 'live').map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">名称</th>
                      <th className="py-2 pr-4 font-medium">Key 前缀</th>
                      <th className="py-2 pr-4 font-medium">Agent ID</th>
                      <th className="py-2 pr-4 font-medium">项目范围</th>
                      <th className="py-2 pr-4 font-medium">业务域范围</th>
                      <th className="py-2 pr-4 font-medium">最近使用</th>
                      <th className="py-2 pr-4 font-medium">状态</th>
                      <th className="py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredKeys.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="py-2 pr-4">{item.label}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {item.key_prefix}…
                        </td>
                        <td className="py-2 pr-4">
                          {item.agent_id ? (
                            <span className="font-mono text-xs">{item.agent_id}</span>
                          ) : (
                            <span className="text-muted-foreground">—（未绑定）</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {formatProjectScope(item.project_scope, projects)}
                        </td>
                        <td className="py-2 pr-4">
                          {formatBusinessScope(item.business_scope)}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {item.last_used_at
                            ? new Date(item.last_used_at).toLocaleString()
                            : '从未使用'}
                        </td>
                        <td className="py-2 pr-4">
                          {item.is_revoked ? (
                            <Badge variant="secondary">已吊销</Badge>
                          ) : (
                            <Badge variant="default">可用</Badge>
                          )}
                        </td>
                        <td className="py-2">
                          {!item.is_revoked && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() => handleRevoke(item)}
                            >
                              吊销
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filteredKeys.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-muted-foreground">
                          暂无凭据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3 调用指南 ───────────────────────────────────────── */}
        <TabsContent value="guide" className="mt-6">
          <AgentUsageGuide />
        </TabsContent>

        {/* ── Tab 4 访问日志（读访问 / 写操作子 Tab） ─────────────── */}
        <TabsContent value="logs" className="mt-6">
          <Tabs defaultValue="read" className="w-full">
            <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-muted/25 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
              <TabsTrigger value="read" className="min-h-9 px-4 py-2 text-sm">
                读访问
              </TabsTrigger>
              <TabsTrigger value="write" className="min-h-9 px-4 py-2 text-sm">
                写操作
              </TabsTrigger>
            </TabsList>
            <TabsContent value="read" className="mt-6">
              <AgentAccessLogsPanel />
            </TabsContent>
            <TabsContent value="write" className="mt-6">
              <AgentOperationLogsPanel />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetForm()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {created ? '凭据创建成功' : '创建 Agent 凭据'}
            </DialogTitle>
          </DialogHeader>
          {created ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-muted-foreground mb-1">明文 Key</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs">
                    {created.plaintext_key}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyPlaintext}>
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">Agent ID</div>
                <code className="rounded bg-muted p-1 font-mono text-xs">
                  {created.agent_id}
                </code>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">项目范围</div>
                <span className="text-sm">
                  {formatProjectScope(created.project_scope, projects)}
                </span>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">业务域范围</div>
                <span className="text-sm">
                  {formatBusinessScope(created.business_scope)}
                </span>
              </div>
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                ⚠ 明文仅展示一次，请妥善保存。调用时 Authorization 用明文 Key，
                X-Agent-Id 用 Agent ID。
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={copyUsage}>
                  {usageCopied ? (
                    <Check className="mr-1 h-4 w-4" />
                  ) : (
                    <Copy className="mr-1 h-4 w-4" />
                  )}
                  {usageCopied ? '已复制调用说明' : '复制调用说明'}
                </Button>
                <Button
                  onClick={() => {
                    setCreateOpen(false)
                    resetForm()
                  }}
                >
                  关闭
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="agent-key-label" className="text-sm font-medium">
                  名称
                </label>
                <input
                  id="agent-key-label"
                  className="mt-1 w-full rounded border bg-background p-2 text-sm"
                  placeholder="如：货件助理 (生产)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="agent-key-agent-id" className="text-sm font-medium">
                  Agent ID
                </label>
                <input
                  id="agent-key-agent-id"
                  className="mt-1 w-full rounded border bg-background p-2 text-sm font-mono"
                  placeholder="如：shipment-assistant-prod"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">
                  项目范围（空 = 全部项目）
                </label>
                <div className="mt-1">
                  <ProjectScopeSelect
                    value={projectScope}
                    selectedIds={selectedProjectIds}
                    onValueChange={setProjectScope}
                    onSelectedIdsChange={setSelectedProjectIds}
                    projects={projects}
                    allHint="该凭据可访问所有项目的数据"
                    specificHint="仅限所选项目，未选中的项目将返回 403"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">
                  业务域范围（空 = 全部业务域）
                </label>
                <div className="mt-1 space-y-2">
                  <button
                    type="button"
                    onClick={() => handleDomainToggleAll(!isBusinessAll)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors',
                      'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                      isBusinessAll && 'bg-accent'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 items-center justify-center rounded-sm border',
                        isBusinessAll
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-input'
                      )}
                    >
                      {isBusinessAll && <Check className="h-3 w-3" />}
                    </div>
                    <span className="font-medium">全部业务域</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {isBusinessAll
                        ? '该凭据可访问所有已接入业务域'
                        : selectedDomainIds.length > 0
                          ? `已选 ${selectedDomainIds.length} 个业务域`
                          : '请选择具体业务域'}
                    </span>
                  </button>
                  <MultiSelect
                    options={domainOptions}
                    selected={selectedDomainIds}
                    onChange={handleDomainIdsChange}
                    placeholder="选择具体业务域..."
                    className={cn(isBusinessAll && 'opacity-50 pointer-events-none')}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={submitting || !label.trim() || !agentId.trim()}
                >
                  {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  创建
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
