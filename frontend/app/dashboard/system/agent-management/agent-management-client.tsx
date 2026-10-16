'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
} from '@/components/ui/data-card'
import { StatusPill, type TableStatus } from '@/components/ui/table-presets'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Loader2, KeyRound, Copy, Check, LayoutGrid, BookOpen, Activity, Pencil, Eye, PenLine } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { ProjectScopeSelect } from '@/components/project-scope-select'
import { MultiSelect, type Option as MultiSelectOption } from '@/components/ui/multi-select'
import { cn } from '@/lib/utils'
import {
  AgentApiKeyItem,
  activateAgentApiKey,
  createAgentApiKey,
  deactivateAgentApiKey,
  deleteAgentApiKey,
  isValidAgentId,
  AGENT_ID_HINT,
  listAgentApiKeys,
  normalizeProjectScope,
  updateAgentApiKey,
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

/** 凭据生命周期状态（BLF-468 §3）：由 is_revoked + expires_at + deleted_at 派生。 */
type KeyStatus = 'active' | 'inactive' | 'expired' | 'deleted'

function getKeyStatus(item: AgentApiKeyItem): KeyStatus {
  if (item.deleted_at) return 'deleted'
  if (
    item.expires_at &&
    new Date(item.expires_at).getTime() <= Date.now()
  ) {
    return 'expired'
  }
  if (item.is_revoked) return 'inactive'
  return 'active'
}

const STATUS_META: Record<
  KeyStatus,
  { label: string; pill: TableStatus; lineThrough?: boolean }
> = {
  active: { label: '激活', pill: 'success' },
  inactive: { label: '停用', pill: 'neutral' },
  expired: { label: '已过期', pill: 'warning' },
  deleted: { label: '已删除', pill: 'neutral', lineThrough: true },
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

/** 解析 ',' 分隔的项目 scope 成 id 数组（'*' → 空，用于编辑 Dialog 预填）。 */
function parseScopeIds(scope: string | null | undefined): string[] {
  const normalized = normalizeProjectScope(scope)
  if (normalized === '*') return []
  return normalized.split(',').map((part) => part.trim()).filter(Boolean)
}

/** 解析 ',' 分隔的业务域 scope 成 code 数组（'*' → 空，用于编辑 Dialog 预填）。 */
function parseScopeCodes(scope: string | null | undefined): string[] {
  const normalized = normalizeBusinessScope(scope)
  if (normalized === '*') return []
  return normalized.split(',').map((part) => part.trim()).filter(Boolean)
}

/**
 * 业务域范围多选控件（BLF-448 创建 Dialog 内联逻辑抽取，BLF-480 编辑复用）。
 * 与 ProjectScopeSelect 同构：顶部「☑️ 全部业务域」首选项，勾选后禁用 MultiSelect；
 * 提交时把空串归一为 '*'（由调用方在提交处归一）。
 */
function BusinessScopeField({
  value,
  selectedIds,
  onValueChange,
  onSelectedIdsChange,
}: {
  value: string
  selectedIds: string[]
  onValueChange: (v: string) => void
  onSelectedIdsChange: (ids: string[]) => void
}) {
  const isAll = value === '*'
  const domainOptions: MultiSelectOption[] = useMemo(() => {
    const domains = liveAgentDomains()
    return domains.map((d) => ({
      value: d.code,
      label: d.code === 'agent_provisioning' ? `${d.label} · 敏感` : d.label,
    }))
  }, [])
  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      onValueChange('*')
      onSelectedIdsChange([])
    } else {
      onValueChange(selectedIds.length > 0 ? selectedIds.join(',') : '')
    }
  }
  const handleIdsChange = (next: string[]) => {
    onSelectedIdsChange(next)
    if (next.length === 0) {
      onValueChange('')
    } else {
      onValueChange(next.join(','))
    }
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => handleToggleAll(!isAll)}
        className={cn(
          'flex w-full items-center gap-2 rounded-none border border-term-border bg-term-bg px-3 py-2 text-sm transition-colors',
          'hover:bg-term-hover focus:outline-none focus:border-term-border-strong',
          isAll && 'bg-term-raised'
        )}
      >
        <div
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-none border border-term-border',
            isAll ? 'bg-term-text text-term-bg' : 'border-term-border-strong'
          )}
        >
          {isAll && <Check className="h-3 w-3" />}
        </div>
        <span className="font-medium">全部业务域</span>
        <span className="ml-auto font-mono text-xs text-term-faint">
          {isAll
            ? '该凭据可访问所有已接入业务域'
            : selectedIds.length > 0
              ? `已选 ${selectedIds.length} 个业务域`
              : '请选择具体业务域'}
        </span>
      </button>
      <MultiSelect
        options={domainOptions}
        selected={selectedIds}
        onChange={handleIdsChange}
        placeholder="选择具体业务域..."
        className={cn(isAll && 'opacity-50 pointer-events-none')}
      />
    </div>
  )
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
  const [statusFilter, setStatusFilter] = useState<KeyStatus | 'all'>('all')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedResult | null>(null)
  const [expiresAt, setExpiresAt] = useState('')
  const [copied, setCopied] = useState(false)
  const [usageCopied, setUsageCopied] = useState(false)
  // ── 编辑态（BLF-480：创建后仍可改权限与业务范围） ────────────────
  const [editing, setEditing] = useState<AgentApiKeyItem | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editProjectScope, setEditProjectScope] = useState('*')
  const [editSelectedProjectIds, setEditSelectedProjectIds] = useState<string[]>([])
  const [editBusinessScope, setEditBusinessScope] = useState('*')
  const [editSelectedDomainIds, setEditSelectedDomainIds] = useState<string[]>([])
  const [editSubmitting, setEditSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await listAgentApiKeys(includeDeleted))
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `加载失败：${error.message}` : '加载失败',
      })
    } finally {
      setLoading(false)
    }
  }, [includeDeleted, notify])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useHeaderRefresh(refresh, { loading })

  const resetForm = useCallback(() => {
    setLabel('')
    setAgentId('')
    setProjectScope('*')
    setSelectedProjectIds([])
    setBusinessScope('*')
    setSelectedDomainIds([])
    setExpiresAt('')
    setCreated(null)
  }, [])

  const agentIdError = useMemo(() => {
    const v = agentId.trim()
    if (!v) return null
    if (!isValidAgentId(v)) return AGENT_ID_HINT
    return null
  }, [agentId])

  const handleCreate = async () => {
    const aid = agentId.trim()
    if (!label.trim() || !aid) return
    if (!isValidAgentId(aid)) {
      notify({ type: 'error', title: `Agent ID 格式错误：${AGENT_ID_HINT}` })
      return
    }
    const exp = expiresAt ? new Date(expiresAt).toISOString() : null
    setSubmitting(true)
    try {
      const result = await createAgentApiKey({
        label: label.trim(),
        agent_id: aid,
        expires_at: exp,
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
      setExpiresAt('')
      await refresh()
    } catch (error) {
      const msg = error instanceof Error ? error.message : '创建失败'
      const is409 = (error as unknown as Record<string, unknown>).status === 409 || (error as unknown as Record<string, unknown>).httpStatus === 409 || msg.includes('已存在有效管理 Key') || msg.includes('单例')
      const friendly = is409 ? '已存在有效管理 Key，请先停用/删除现役后再签' : msg
      notify({
        type: 'error',
        title: `创建失败：${friendly}`,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const openEdit = (item: AgentApiKeyItem) => {
    setEditing(item)
    setEditLabel(item.label)
    setEditProjectScope(item.project_scope ?? '*')
    setEditSelectedProjectIds(parseScopeIds(item.project_scope))
    setEditBusinessScope(item.business_scope ?? '*')
    setEditSelectedDomainIds(parseScopeCodes(item.business_scope))
    setEditSubmitting(false)
  }

  const closeEdit = () => {
    setEditing(null)
    setEditSubmitting(false)
  }

  const handleUpdate = async () => {
    if (!editing) return
    setEditSubmitting(true)
    try {
      await updateAgentApiKey(editing.id, {
        label: editLabel.trim(),
        project_scope: normalizeProjectScope(editProjectScope),
        business_scope: normalizeBusinessScope(editBusinessScope),
      })
      notify({ type: 'success', title: `已更新：${editLabel.trim() || editing.label}` })
      setEditing(null)
      await refresh()
    } catch (error) {
      const msg = error instanceof Error ? error.message : '更新失败'
      const is409 = (error as unknown as Record<string, unknown>).status === 409 || (error as unknown as Record<string, unknown>).httpStatus === 409 || msg.includes('已存在有效管理 Key') || msg.includes('单例')
      const friendly = is409 ? '已存在有效管理 Key，请先停用/删除现役后再签' : msg
      notify({
        type: 'error',
        title: `更新失败：${friendly}`,
      })
    } finally {
      setEditSubmitting(false)
    }
  }

  const handleDeactivate = async (item: AgentApiKeyItem) => {
    const ok = await confirm({
      title: `停用凭据「${item.label}」？`,
      description: '停用后使用该凭据的 Agent 将立即无法访问。可随时重新激活，凭据本身不会失效。',
      confirmText: '停用',
    })
    if (!ok) return
    try {
      await deactivateAgentApiKey(item.id)
      notify({ type: 'success', title: `已停用：${item.label}` })
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `停用失败：${error.message}` : '停用失败',
      })
    }
  }

  const handleActivate = async (item: AgentApiKeyItem) => {
    const ok = await confirm({
      title: `激活凭据「${item.label}」？`,
      description:
        '激活后该凭据恢复访问权限。⚠️ 若此前是因疑似泄露而停用，建议新建凭据轮换，而非复用旧 Key。',
      confirmText: '激活',
    })
    if (!ok) return
    try {
      await activateAgentApiKey(item.id)
      notify({ type: 'success', title: `已激活：${item.label}` })
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `激活失败：${error.message}` : '激活失败',
      })
    }
  }

  const handleDelete = async (item: AgentApiKeyItem) => {
    const ok = await confirm({
      title: `删除凭据「${item.label}」？`,
      description:
        '删除后不可恢复，使用该凭据的 Agent 将永久无法访问（审计日志保留）。',
      confirmText: '删除',
      variant: 'destructive',
      inputLabel: `请输入 Key 前缀 ${item.key_prefix} 确认删除`,
      expectedInput: item.key_prefix,
    })
    if (!ok) return
    try {
      await deleteAgentApiKey(item.id)
      notify({ type: 'success', title: `已删除：${item.label}` })
      await refresh()
    } catch (error) {
      notify({
        type: 'error',
        title: error instanceof Error ? `删除失败：${error.message}` : '删除失败',
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

  // ── 凭据管理 Tab 数据（业务域 + 状态筛选） ────────────────
  const filteredKeys = useMemo(() => {
    return keys.filter((k) => {
      if (domainFilter !== 'all' && !scopeHasDomain(k.business_scope, domainFilter))
        return false
      if (statusFilter !== 'all' && getKeyStatus(k) !== statusFilter) return false
      return true
    })
  }, [keys, domainFilter, statusFilter])

  // ── 业务域概览 Tab 数据（每域授权凭据数） ────────────────────────
  const domainStats = useMemo(() => {
    return AGENT_DOMAINS.map((domain) => ({
      domain,
      keyCount: keys.filter((k) => scopeHasDomain(k.business_scope, domain.code)).length,
    }))
  }, [keys])

  return (
    <div className="w-full space-y-4">
      {/* BLF-838：页面标题由 Top Header 面包屑承载；仅保留操作区（终端规格） */}
      <div className="flex justify-end">
        <Button
          onClick={() => setCreateOpen(true)}
          className="h-9 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
        >
          创建凭据
        </Button>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList variant="term">
          <TabsTrigger value="overview" variant="term">
            <LayoutGrid className="h-3.5 w-3.5" />
            业务域概览
          </TabsTrigger>
          <TabsTrigger value="credentials" variant="term">
            <KeyRound className="h-3.5 w-3.5" />
            凭据管理
          </TabsTrigger>
          <TabsTrigger value="guide" variant="term">
            <BookOpen className="h-3.5 w-3.5" />
            调用指南
          </TabsTrigger>
          <TabsTrigger value="logs" variant="term">
            <Activity className="h-3.5 w-3.5" />
            访问日志
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1 业务域概览 ─────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-4 space-y-2">
          <DataTableCard>
            <DataTableCardHeader
              title="业务域接入一览"
              description="各业务域的 Agent API 接入状态与已授权凭据数"
            />
            <DataTableCardBody className="p-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {domainStats.map(({ domain, keyCount }) => (
                  <div
                    key={domain.code}
                    className={cn(
                      'rounded-none border p-3',
                      domain.status === 'live'
                        ? 'border-term-pos/40 bg-term-pos/5'
                        : 'border-dashed border-term-border bg-term-bg'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{domain.label}</span>
                      {domain.status === 'live' ? (
                        <Badge variant="outline" className="rounded-none border-term-pos/40 font-mono text-[11px] text-term-pos">
                          已接入
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="rounded-none font-mono text-[11px] text-term-faint">规划中</Badge>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-term-muted line-clamp-2">
                      {domain.description}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-xs">
                      {domain.status === 'live' && (
                        <Badge variant="outline" className="rounded-none font-mono text-[11px] text-term-muted">{domain.routeCount} 路由</Badge>
                      )}
                      {domain.capabilities.read && (
                        <Badge variant="outline" className="rounded-none font-mono text-[11px] text-term-muted">读</Badge>
                      )}
                      {domain.capabilities.write && (
                        <Badge variant="outline" className="rounded-none font-mono text-[11px] text-term-muted">写</Badge>
                      )}
                      <span className="ml-auto tabular-nums text-term-faint">
                        {domain.status === 'live' ? `${keyCount} 张凭据授权` : '待接入'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </DataTableCardBody>
          </DataTableCard>
        </TabsContent>

        {/* ── Tab 2 凭据管理 ───────────────────────────────────────── */}
        <TabsContent value="credentials" className="mt-6 space-y-4">
          <DataTableCard>
            <DataTableCardHeader>
              <div className="flex w-full flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-base font-semibold leading-none text-foreground">凭据列表</h2>
                  <p className="text-sm text-muted-foreground">
                    管理 Agent 凭据的生命周期状态与项目 / 业务域权限范围
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={includeDeleted}
                      onChange={(e) => setIncludeDeleted(e.target.checked)}
                      className="h-4 w-4 rounded-none border-term-border accent-term-text"
                      aria-label="含已删除"
                    />
                    含已删除
                  </label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as KeyStatus | 'all')}
                    className="h-9 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs text-term-text"
                    aria-label="按状态筛选"
                  >
                    <option value="all">全部状态</option>
                    <option value="active">激活</option>
                    <option value="inactive">停用</option>
                    <option value="expired">已过期</option>
                  </select>
                  <select
                    value={domainFilter}
                    onChange={(e) => setDomainFilter(e.target.value)}
                    className="h-9 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs text-term-text focus:outline-none focus:border-term-border-strong"
                    aria-label="按业务域筛选"
                  >
                    <option value="all">全部业务域</option>
                    {AGENT_DOMAINS.filter((d) => d.status === 'live').map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </DataTableCardHeader>
            <DataTableCardBody>
              {loading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-term-faint" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[170px]">名称</TableHead>
                      <TableHead>Key 前缀</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>项目范围</TableHead>
                      <TableHead>业务域范围</TableHead>
                      <TableHead>最近使用</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="w-[160px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredKeys.map((item) => {
                      const status = getKeyStatus(item)
                      const statusMeta = STATUS_META[status]
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.label}</TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {item.key_prefix}…
                          </TableCell>
                          <TableCell>
                            {item.agent_id ? (
                              <code className="font-mono text-xs text-term-muted">{item.agent_id}</code>
                            ) : (
                              <span className="text-term-faint">—（未绑定）</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {formatProjectScope(item.project_scope, projects)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {formatBusinessScope(item.business_scope)}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums text-term-muted">
                            {item.last_used_at
                              ? new Date(item.last_used_at).toLocaleString()
                              : '从未使用'}
                          </TableCell>
                          <TableCell>
                            <StatusPill
                              status={statusMeta.pill}
                              label={statusMeta.label}
                              dot={status !== 'deleted'}
                              className={statusMeta.lineThrough ? 'line-through' : undefined}
                            />
                          </TableCell>
                          <TableCell>
                            {status === 'deleted' ? null : (
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEdit(item)}
                                >
                                  <Pencil className="mr-1 h-3.5 w-3.5" />
                                  编辑
                                </Button>
                                {status === 'active' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleDeactivate(item)}
                                  >
                                    停用
                                  </Button>
                                )}
                                {status === 'inactive' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-term-pos hover:text-term-pos"
                                    onClick={() => handleActivate(item)}
                                  >
                                    激活
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive"
                                  onClick={() => handleDelete(item)}
                                >
                                  删除
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {filteredKeys.length === 0 && (
                      <EmptyTableState colSpan={8} message="暂无凭据" />
                    )}
                  </TableBody>
                </Table>
              )}
            </DataTableCardBody>
          </DataTableCard>
        </TabsContent>

        {/* ── Tab 3 调用指南 ───────────────────────────────────────── */}
        <TabsContent value="guide" className="mt-6">
          <AgentUsageGuide />
        </TabsContent>

        {/* ── Tab 4 访问日志（读访问 / 写操作子 Tab） ─────────────── */}
        <TabsContent value="logs" className="mt-6">
          <Tabs defaultValue="read" className="w-full">
            <TabsList variant="term">
              <TabsTrigger value="read" variant="term">
                <Eye aria-hidden />
                读访问
              </TabsTrigger>
              <TabsTrigger value="write" variant="term">
                <PenLine aria-hidden />
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
                  <code className="flex-1 break-all rounded-none bg-term-raised p-2 font-mono text-xs">
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
                <div className="text-muted-foreground mb-1">Agent</div>
                <code className="rounded-none bg-term-raised p-1 font-mono text-xs">
                  {created.agent_id}
                </code>
                <span className="ml-2 text-sm text-foreground">
                  （{created.label}）
                </span>
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
              <p className="rounded-none border border-term-warn/50 bg-term-warn/10 p-2 font-sans text-term-warn">
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
              <div className="space-y-1.5">
                <label htmlFor="agent-key-label" className="text-sm font-medium">
                  名称
                </label>
                <Input
                  id="agent-key-label"
                  placeholder="如：货件助理 (生产)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="agent-key-agent-id" className="text-sm font-medium">
                  Agent ID
                </label>
                <Input
                  id="agent-key-agent-id"
                  className="font-mono"
                  placeholder="如：shipment-assistant-prod"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  aria-invalid={agentIdError ? true : undefined}
                />
                {agentIdError ? (
                  <p className="text-xs text-destructive">{agentIdError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{AGENT_ID_HINT}</p>
                )}
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
                <div className="mt-1">
                  <BusinessScopeField
                    value={businessScope}
                    selectedIds={selectedDomainIds}
                    onValueChange={setBusinessScope}
                    onSelectedIdsChange={setSelectedDomainIds}
                  />
                </div>
                {selectedDomainIds.includes('agent_provisioning') && (
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-destructive">
                    <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                    敏感域：凭据签发（全局单例，409 需先停用现役）
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="agent-key-expires" className="text-sm font-medium">
                  过期时间（可选，空 = 永久有效）
                </label>
                <Input
                  id="agent-key-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={submitting || !label.trim() || !agentId.trim() || !!agentIdError}
                >
                  {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  创建
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── 编辑凭据权限 / 业务范围 Dialog（BLF-480） ─────────────── */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) closeEdit()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑凭据权限</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="edit-agent-key-label" className="text-sm font-medium">
                  名称
                </label>
                <Input
                  id="edit-agent-key-label"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </div>
              <div className="rounded-none border border-term-border bg-term-bg p-3 text-sm">
                <div className="text-muted-foreground">Agent ID（不可改，凭据绑定标识）</div>
                <code className="font-mono text-xs">
                  {editing.agent_id ?? '—（未绑定）'}
                </code>
              </div>
              <div>
                <label className="text-sm font-medium">
                  项目范围（空 = 全部项目）
                </label>
                <div className="mt-1">
                  <ProjectScopeSelect
                    value={editProjectScope}
                    selectedIds={editSelectedProjectIds}
                    onValueChange={setEditProjectScope}
                    onSelectedIdsChange={setEditSelectedProjectIds}
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
                <div className="mt-1">
                  <BusinessScopeField
                    value={editBusinessScope}
                    selectedIds={editSelectedDomainIds}
                    onValueChange={setEditBusinessScope}
                    onSelectedIdsChange={setEditSelectedDomainIds}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeEdit}>
                  取消
                </Button>
                <Button
                  onClick={handleUpdate}
                  disabled={editSubmitting || !editLabel.trim()}
                >
                  {editSubmitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  保存
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
