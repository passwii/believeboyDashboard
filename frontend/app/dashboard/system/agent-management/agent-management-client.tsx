'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { KeyRound, Copy, Check, LayoutGrid, BookOpen, Activity, Pencil, Eye, PenLine } from 'lucide-react'
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
import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import styles from './agent-management-warm.module.css'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './agent-warm-dialog'

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
  { label: string; tone: WarmBadgeTone; lineThrough?: boolean }
> = {
  active: { label: '激活', tone: 'positive' },
  inactive: { label: '停用', tone: 'neutral' },
  expired: { label: '已过期', tone: 'accent' },
  deleted: { label: '已删除', tone: 'neutral', lineThrough: true },
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
          styles.scopeToggle,
          isAll && styles.scopeToggleSelected
        )}
        aria-pressed={isAll}
      >
        <div
          className={cn(
            styles.scopeCheckbox,
            isAll && styles.scopeCheckboxSelected
          )}
          aria-hidden
        >
          {isAll && <Check className={styles.scopeCheckIcon} />}
        </div>
        <span className={styles.scopeToggleLabel}>全部业务域</span>
        <span className={styles.scopeToggleHint}>
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
        className={cn(isAll && styles.scopeMultiSelectDisabled)}
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
    <div className={styles.page} data-warm-agent-management="true">
      <div className={styles.pageActions}>
        <WarmButton variant="primary" onClick={() => setCreateOpen(true)}>
          创建凭据
        </WarmButton>
      </div>

      <Tabs defaultValue="overview" className={styles.tabs}>
        <TabsList className={styles.tabList}>
          <TabsTrigger value="overview" className={styles.tab}>
            <LayoutGrid className={styles.tabIcon} aria-hidden />
            业务域概览
          </TabsTrigger>
          <TabsTrigger value="credentials" className={styles.tab}>
            <KeyRound className={styles.tabIcon} aria-hidden />
            凭据管理
          </TabsTrigger>
          <TabsTrigger value="guide" className={styles.tab}>
            <BookOpen className={styles.tabIcon} aria-hidden />
            调用指南
          </TabsTrigger>
          <TabsTrigger value="logs" className={styles.tab}>
            <Activity className={styles.tabIcon} aria-hidden />
            访问日志
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1 业务域概览 ─────────────────────────────────────── */}
        <TabsContent value="overview" className={styles.tabContent}>
          <section className={styles.panel}>
            <header className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>业务域接入一览</h2>
                <p className={styles.sectionDescription}>
                  各业务域的 Agent API 接入状态与已授权凭据数
                </p>
              </div>
            </header>
            <div className={styles.domainGrid}>
              {domainStats.map(({ domain, keyCount }) => (
                <article
                  key={domain.code}
                  className={cn(
                    styles.domainCard,
                    domain.status === 'live'
                      ? styles.domainCardLive
                      : styles.domainCardPlanned
                  )}
                >
                  <div className={styles.domainHeader}>
                    <span className={styles.domainName}>{domain.label}</span>
                    <WarmBadge tone={domain.status === 'live' ? 'positive' : 'neutral'}>
                      {domain.status === 'live' ? '已接入' : '规划中'}
                    </WarmBadge>
                  </div>
                  <p className={styles.domainDescription}>{domain.description}</p>
                  <div className={styles.domainMeta}>
                    {domain.status === 'live' && (
                      <WarmBadge tone="neutral">{domain.routeCount} 路由</WarmBadge>
                    )}
                    {domain.capabilities.read && (
                      <WarmBadge tone="neutral">读</WarmBadge>
                    )}
                    {domain.capabilities.write && (
                      <WarmBadge tone="neutral">写</WarmBadge>
                    )}
                    <span className={styles.domainCount}>
                      {domain.status === 'live' ? `${keyCount} 张凭据授权` : '待接入'}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </TabsContent>

        {/* ── Tab 2 凭据管理 ───────────────────────────────────────── */}
        <TabsContent value="credentials" className={styles.tabContent}>
          <section className={styles.panel}>
            <header className={styles.credentialsHeader}>
              <div className={styles.credentialsHeading}>
                <h2 className={styles.sectionTitle}>凭据列表</h2>
                <p className={styles.sectionDescription}>
                    管理 Agent 凭据的生命周期状态与项目 / 业务域权限范围
                </p>
              </div>
              <div className={styles.filters}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={includeDeleted}
                    onChange={(e) => setIncludeDeleted(e.target.checked)}
                    className={styles.checkbox}
                    aria-label="含已删除"
                  />
                  含已删除
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as KeyStatus | 'all')}
                  className={styles.nativeSelect}
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
                  className={styles.nativeSelect}
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
            </header>
            <div className={styles.tableScroll}>
              {loading ? (
                <div className={styles.loadingState} role="status">
                  加载中…
                </div>
              ) : (
                <table className={styles.table} aria-label="凭据列表">
                  <thead>
                    <tr>
                      <th className={styles.nameColumn}>名称</th>
                      <th>Key 前缀</th>
                      <th>Agent</th>
                      <th>项目范围</th>
                      <th>业务域范围</th>
                      <th>最近使用</th>
                      <th>状态</th>
                      <th className={styles.actionsColumn}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredKeys.map((item) => {
                      const status = getKeyStatus(item)
                      const statusMeta = STATUS_META[status]
                      return (
                        <tr key={item.id}>
                          <td className={styles.primaryCell}>{item.label}</td>
                          <td className={styles.monoCell}>
                            {item.key_prefix}…
                          </td>
                          <td>
                            {item.agent_id ? (
                              <code className={styles.agentCode}>{item.agent_id}</code>
                            ) : (
                              <span className={styles.faintText}>—（未绑定）</span>
                            )}
                          </td>
                          <td>
                            {formatProjectScope(item.project_scope, projects)}
                          </td>
                          <td className={styles.monoCell}>
                            {formatBusinessScope(item.business_scope)}
                          </td>
                          <td className={styles.timeCell}>
                            {item.last_used_at
                              ? new Date(item.last_used_at).toLocaleString()
                              : '从未使用'}
                          </td>
                          <td>
                            <WarmBadge
                              tone={statusMeta.tone}
                              className={cn(
                                styles.statusBadge,
                                statusMeta.lineThrough && styles.statusDeleted
                              )}
                            >
                              {statusMeta.label}
                            </WarmBadge>
                          </td>
                          <td>
                            {status === 'deleted' ? null : (
                              <div className={styles.rowActions}>
                                <WarmButton
                                  variant="quiet"
                                  className={styles.rowAction}
                                  onClick={() => openEdit(item)}
                                >
                                  <Pencil className={styles.rowActionIcon} aria-hidden />
                                  编辑
                                </WarmButton>
                                {status === 'active' && (
                                  <WarmButton
                                    variant="quiet"
                                    className={styles.rowAction}
                                    onClick={() => handleDeactivate(item)}
                                  >
                                    停用
                                  </WarmButton>
                                )}
                                {status === 'inactive' && (
                                  <WarmButton
                                    variant="quiet"
                                    className={cn(styles.rowAction, styles.positiveAction)}
                                    onClick={() => handleActivate(item)}
                                  >
                                    激活
                                  </WarmButton>
                                )}
                                <WarmButton
                                  variant="quiet"
                                  className={cn(styles.rowAction, styles.dangerAction)}
                                  onClick={() => handleDelete(item)}
                                >
                                  删除
                                </WarmButton>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {filteredKeys.length === 0 && (
                      <tr>
                        <td colSpan={8} className={styles.emptyCell}>暂无凭据</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </TabsContent>

        {/* ── Tab 3 调用指南 ───────────────────────────────────────── */}
        <TabsContent value="guide" className={styles.tabContent}>
          <AgentUsageGuide />
        </TabsContent>

        {/* ── Tab 4 访问日志（读访问 / 写操作子 Tab） ─────────────── */}
        <TabsContent value="logs" className={styles.tabContent}>
          <Tabs defaultValue="read" className={styles.logTabs}>
            <TabsList className={styles.logTabList}>
              <TabsTrigger value="read" className={styles.tab}>
                <Eye aria-hidden />
                读访问
              </TabsTrigger>
              <TabsTrigger value="write" className={styles.tab}>
                <PenLine aria-hidden />
                写操作
              </TabsTrigger>
            </TabsList>
            <TabsContent value="read" className={styles.logTabContent}>
              <AgentAccessLogsPanel />
            </TabsContent>
            <TabsContent value="write" className={styles.logTabContent}>
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
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {created ? '凭据创建成功' : '创建 Agent 凭据'}
            </DialogTitle>
          </DialogHeader>
          {created ? (
            <div className={styles.dialogStack}>
              <div className={styles.detailBlock}>
                <div className={styles.detailLabel}>明文 Key</div>
                <div className={styles.secretRow}>
                  <code className={styles.secretCode}>
                    {created.plaintext_key}
                  </code>
                  <WarmButton
                    aria-label="复制明文 Key"
                    className={styles.iconAction}
                    onClick={copyPlaintext}
                  >
                    {copied ? (
                      <Check className={styles.actionIcon} aria-hidden />
                    ) : (
                      <Copy className={styles.actionIcon} aria-hidden />
                    )}
                  </WarmButton>
                </div>
              </div>
              <div className={styles.detailBlock}>
                <div className={styles.detailLabel}>Agent</div>
                <code className={styles.inlineCode}>
                  {created.agent_id}
                </code>
                <span className={styles.detailValue}>
                  （{created.label}）
                </span>
              </div>
              <div className={styles.detailBlock}>
                <div className={styles.detailLabel}>项目范围</div>
                <span className={styles.detailValue}>
                  {formatProjectScope(created.project_scope, projects)}
                </span>
              </div>
              <div className={styles.detailBlock}>
                <div className={styles.detailLabel}>业务域范围</div>
                <span className={styles.detailValue}>
                  {formatBusinessScope(created.business_scope)}
                </span>
              </div>
              <p className={styles.warning}>
                ⚠ 明文仅展示一次，请妥善保存。调用时 Authorization 用明文 Key，
                X-Agent-Id 用 Agent ID。
              </p>
              <DialogFooter className={styles.dialogFooter}>
                <WarmButton onClick={copyUsage}>
                  {usageCopied ? (
                    <Check className={styles.actionIcon} aria-hidden />
                  ) : (
                    <Copy className={styles.actionIcon} aria-hidden />
                  )}
                  {usageCopied ? '已复制调用说明' : '复制调用说明'}
                </WarmButton>
                <WarmButton
                  variant="primary"
                  onClick={() => {
                    setCreateOpen(false)
                    resetForm()
                  }}
                >
                  关闭
                </WarmButton>
              </DialogFooter>
            </div>
          ) : (
            <div className={styles.dialogStack}>
              <div className={styles.field}>
                <label htmlFor="agent-key-label" className={styles.label}>
                  名称
                </label>
                <input
                  id="agent-key-label"
                  className={styles.input}
                  placeholder="如：货件助理 (生产)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="agent-key-agent-id" className={styles.label}>
                  Agent ID
                </label>
                <input
                  id="agent-key-agent-id"
                  className={cn(styles.input, styles.monoInput)}
                  placeholder="如：shipment-assistant-prod"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  aria-invalid={agentIdError ? true : undefined}
                />
                {agentIdError ? (
                  <p className={styles.errorText}>{agentIdError}</p>
                ) : (
                  <p className={styles.helpText}>{AGENT_ID_HINT}</p>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.label}>
                  项目范围（空 = 全部项目）
                </label>
                <div className={styles.scopeField}>
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
              <div className={styles.field}>
                <label className={styles.label}>
                  业务域范围（空 = 全部业务域）
                </label>
                <div className={styles.scopeField}>
                  <BusinessScopeField
                    value={businessScope}
                    selectedIds={selectedDomainIds}
                    onValueChange={setBusinessScope}
                    onSelectedIdsChange={setSelectedDomainIds}
                  />
                </div>
                {selectedDomainIds.includes('agent_provisioning') && (
                  <p className={styles.sensitiveHint}>
                    <span className={styles.sensitiveDot} aria-hidden />
                    敏感域：凭据签发（全局单例，409 需先停用现役）
                  </p>
                )}
              </div>
              <div className={styles.field}>
                <label htmlFor="agent-key-expires" className={styles.label}>
                  过期时间（可选，空 = 永久有效）
                </label>
                <input
                  id="agent-key-expires"
                  className={styles.input}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
              <DialogFooter className={styles.dialogFooter}>
                <WarmButton onClick={() => setCreateOpen(false)}>
                  取消
                </WarmButton>
                <WarmButton
                  variant="primary"
                  onClick={handleCreate}
                  disabled={submitting || !label.trim() || !agentId.trim() || !!agentIdError}
                  loading={submitting}
                  loadingLabel="正在创建凭据"
                >
                  {submitting ? '创建中...' : '创建'}
                </WarmButton>
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
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>编辑凭据权限</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className={styles.dialogStack}>
              <div className={styles.field}>
                <label htmlFor="edit-agent-key-label" className={styles.label}>
                  名称
                </label>
                <input
                  id="edit-agent-key-label"
                  className={styles.input}
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </div>
              <div className={styles.readonlyBlock}>
                <div className={styles.detailLabel}>Agent ID（不可改，凭据绑定标识）</div>
                <code className={styles.agentCode}>
                  {editing.agent_id ?? '—（未绑定）'}
                </code>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>
                  项目范围（空 = 全部项目）
                </label>
                <div className={styles.scopeField}>
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
              <div className={styles.field}>
                <label className={styles.label}>
                  业务域范围（空 = 全部业务域）
                </label>
                <div className={styles.scopeField}>
                  <BusinessScopeField
                    value={editBusinessScope}
                    selectedIds={editSelectedDomainIds}
                    onValueChange={setEditBusinessScope}
                    onSelectedIdsChange={setEditSelectedDomainIds}
                  />
                </div>
              </div>
              <DialogFooter className={styles.dialogFooter}>
                <WarmButton onClick={closeEdit}>
                  取消
                </WarmButton>
                <WarmButton
                  variant="primary"
                  onClick={handleUpdate}
                  disabled={editSubmitting || !editLabel.trim()}
                  loading={editSubmitting}
                  loadingLabel="正在保存凭据权限"
                >
                  {editSubmitting ? '保存中...' : '保存'}
                </WarmButton>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
