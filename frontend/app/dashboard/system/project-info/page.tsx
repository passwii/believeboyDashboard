'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  PencilLine,
  PlusCircle,
  Settings,
  FileText,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { ProjectContextDrawer } from '@/components/dashboard/project-context/project-context-drawer'
import { ProjectContextTab } from '@/components/dashboard/project-context/project-context-tab'
import {
  clearProjectClientCaches,
  fetchManagedProjectsCached,
  fetchProjectOperatorOptionsCached,
} from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { getCountryLabel } from '@/lib/country'
import { fetchWorkflowSummary, type ProjectWorkflowSummaryWorkflow } from '@/lib/project-workflows-api'
import {
  deriveProjectStartupStatus,
  PROJECT_STARTUP_STATUS_LABELS,
} from '@/lib/project-startup-status'
import styles from './project-info-warm.module.css'

type ProjectItem = {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  sort_order: number
  is_active: boolean
  source_file: string | null
  has_context: boolean
  project_tier: string | null
  country: string
  country_name: string | null
}


type CommissionBasisOption = {
  label: string
  value: string
}

const API_BASE = '/api/backend'
const COMMISSION_BASIS_OPTIONS: CommissionBasisOption[] = [
  { label: '销售额', value: 'sales_amount' },
  { label: '平台回款', value: 'cash_received' },
  { label: '利润率', value: 'profit_margin' },
]
const COMMISSION_BASIS_LABEL: Record<string, string> = {
  sales_amount: '销售额',
  cash_received: '平台回款',
  profit_margin: '利润率',
}
const OPERATOR_SPLIT_RE = /[、,，;\n]+/

const TIER_OPTIONS = [
  { label: 'T1', value: 'T1' },
  { label: 'T2', value: 'T2' },
  { label: 'T3', value: 'T3' },
  { label: 'T4', value: 'T4' },
]

const TIER_LABEL: Record<string, string> = { T1: 'T1', T2: 'T2', T3: 'T3', T4: 'T4' }

// Radix Select 的 item 不接受空字符串，用哨兵值表达「未分级」，提交时映射回 null（清空）。
const TIER_NONE_VALUE = '__none__'

const TIER_SELECT_OPTIONS = [{ label: '未分级', value: TIER_NONE_VALUE }, ...TIER_OPTIONS]

const PROJECT_COUNTRY_OPTIONS = ['US', 'DE', 'UK'].map((code) => ({
  value: code,
  label: `${getCountryLabel(code)} (${code})`,
}))

type ProjectShop = {
  id: number
  country: string
  shop_id: string
}

const SHOP_COUNTRY_OPTIONS = PROJECT_COUNTRY_OPTIONS

function emptyShopIds(): Record<string, string> {
  return Object.fromEntries(SHOP_COUNTRY_OPTIONS.map(({ value }) => [value, '']))
}

function parseOperatorNames(value: string | null): string[] {
  if (!value) {
    return []
  }

  const seen = new Set<string>()
  const items: string[] = []
  for (const raw of value.split(OPERATOR_SPLIT_RE)) {
    const normalized = raw.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    items.push(normalized)
  }
  return items
}

function serializeOperatorNames(values: string[]): string | null {
  if (values.length === 0) {
    return null
  }
  return values.join('、')
}

function toggleOperatorName(values: string[], name: string): string[] {
  return values.includes(name) ? values.filter((item) => item !== name) : [...values, name]
}

function renderOperatorSummary(values: string[]): string {
  if (values.length === 0) {
    return ''
  }
  if (values.length <= 2) {
    return values.join('、')
  }
  return `${values.slice(0, 2).join('、')} 等 ${values.length} 人`
}

type OperatorMultiSelectProps = {
  buttonId?: string
  value: string[]
  options: string[]
  placeholder: string
  disabled?: boolean
  onChange: (next: string[]) => void
}

function OperatorMultiSelect({
  buttonId,
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
}: OperatorMultiSelectProps) {
  const summary = renderOperatorSummary(value)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={buttonId}
          disabled={disabled}
          className={styles.multiSelectTrigger}
        >
          <span
            className={cn(styles.multiSelectSummary, !summary && styles.multiSelectPlaceholder)}
          >
            {summary || placeholder}
          </span>
          <ChevronsUpDown className={styles.multiSelectIcon} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={styles.multiSelectContent}>
        <div className={styles.multiSelectList}>
          {options.length > 0 ? (
            options.map((name) => {
              const checked = value.includes(name)
              return (
                <label key={`operator-multi-${name}`} className={styles.multiSelectOption}>
                  <Checkbox
                    className={styles.checkbox}
                    checked={checked}
                    onCheckedChange={() => onChange(toggleOperatorName(value, name))}
                  />
                  <span className="flex-1">{name}</span>
                </label>
              )
            })
          ) : (
            <p className={styles.multiSelectEmpty}>暂无可选运营</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  const raw = await response.text()
  const text = raw.trim()

  try {
    const payload = JSON.parse(raw) as { detail?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail
    }
    if (Array.isArray(payload.detail)) {
      const messages = payload.detail
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          if (item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string') {
            return item.msg
          }
          return JSON.stringify(item)
        })
        .filter(Boolean)
      if (messages.length > 0) {
        return messages.join('; ')
      }
    }
    if (payload.detail && typeof payload.detail === 'object') {
      return JSON.stringify(payload.detail)
    }
    return text || `请求失败 (${response.status})`
  } catch {
    return text || `请求失败 (${response.status})`
  }
}

function toCommissionPoints(rate: number | null): number | null {
  if (rate === null) {
    return null
  }
  return Number((rate * 100).toFixed(4))
}

function startupStatusTone(status: ReturnType<typeof deriveProjectStartupStatus>) {
  if (status === 'launched') return 'success'
  if (status === 'launching') return 'warning'
  return 'neutral'
}

function StartupStatusPill({
  workflows,
}: {
  workflows: readonly ProjectWorkflowSummaryWorkflow[]
}) {
  const status = deriveProjectStartupStatus(workflows)
  const tone = startupStatusTone(status)
  return (
    <span
      className={cn(
        styles.statusPill,
        tone === 'success'
          ? styles.statusSuccess
          : tone === 'warning'
            ? styles.statusWarning
            : styles.statusNeutral
      )}
    >
      <span className={styles.statusDot} aria-hidden="true" />
      {PROJECT_STARTUP_STATUS_LABELS[status]}
    </span>
  )
}

function ProjectStatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={cn(styles.statusPill, active ? styles.statusSuccess : styles.statusNeutral)}
    >
      <span className={styles.statusDot} aria-hidden="true" />
      {active ? '启用' : '停用'}
    </span>
  )
}

export default function ProjectInfoPage() {
  const shopLoadRequestRef = useRef(0)
  const startupSummaryRequestRef = useRef(0)
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  const { data: session, status } = useSession()
  const { notify } = useNotifications()
  const searchParams = useSearchParams()
  const [items, setItems] = useState<ProjectItem[]>([])
  const [loading, setLoading] = useState(false)
  const [startupWorkflowsByProject, setStartupWorkflowsByProject] = useState<
    Map<number, ProjectWorkflowSummaryWorkflow[]>
  >(new Map())
  const [startupSummaryLoading, setStartupSummaryLoading] = useState(true)
  const [startupSummaryError, setStartupSummaryError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [operatorOptions, setOperatorOptions] = useState<string[]>([])
  const [movingId, setMovingId] = useState<number | null>(null)

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addBrandName, setAddBrandName] = useState('')
  const [addStoreAddress, setAddStoreAddress] = useState('')
  const [addProjectOperators, setAddProjectOperators] = useState<string[]>([])
  const [addAssistantOperators, setAddAssistantOperators] = useState<string[]>([])
  const [addCommissionMode, setAddCommissionMode] = useState('')
  const [addCommissionRate, setAddCommissionRate] = useState('')
  const [addProjectTier, setAddProjectTier] = useState(TIER_NONE_VALUE)
  const [addCountry, setAddCountry] = useState('US')

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ProjectItem | null>(null)
  const [editName, setEditName] = useState('')
  const [editBrandName, setEditBrandName] = useState('')
  const [editStoreAddress, setEditStoreAddress] = useState('')
  const [editProjectOperators, setEditProjectOperators] = useState<string[]>([])
  const [editAssistantOperators, setEditAssistantOperators] = useState<string[]>([])
  const [editCommissionMode, setEditCommissionMode] = useState('')
  const [editCommissionRate, setEditCommissionRate] = useState('')
  const [editIsActive, setEditIsActive] = useState(true)
  const [editProjectTier, setEditProjectTier] = useState(TIER_NONE_VALUE)
  const [editShopIds, setEditShopIds] = useState<Record<string, string>>(emptyShopIds)
  const [shopLoadError, setShopLoadError] = useState<string | null>(null)
  const [loadingShopIds, setLoadingShopIds] = useState(false)
  const [editOriginalShopIds, setEditOriginalShopIds] = useState<Record<string, string>>(emptyShopIds)
  const [editCountry, setEditCountry] = useState('US')

  const [contextDrawerOpen, setContextDrawerOpen] = useState(false)
  const [contextProjectId, setContextProjectId] = useState<number | null>(null)
  const [contextProjectName, setContextProjectName] = useState('')

  const openContextDrawer = (item: ProjectItem) => {
    setContextProjectId(item.id)
    setContextProjectName(item.name)
    setContextDrawerOpen(true)
  }
  const isAddCashReceivedCommission = addCommissionMode === 'cash_received'
  const isEditCashReceivedCommission = editCommissionMode === 'cash_received'
  const { showSkeleton, isRefreshing } = useSmoothRefresh({ loading, hasData: items.length > 0 })

  const loadOperatorOptions = useCallback(async () => {
    try {
      const payload = await fetchProjectOperatorOptionsCached()
      setOperatorOptions(payload)
    } catch {
      setOperatorOptions([])
    }
  }, [])

  const moveProject = async (projectId: number, direction: 'up' | 'down') => {
    setMovingId(projectId)
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/move-${direction}`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
        },
      })
      if (!response.ok) {
        const error = await parseError(response)
        throw new Error(error)
      }
      clearProjectClientCaches()
      await loadProjects()
      notify({
        type: 'success',
        title: '项目已移动',
        message: `项目已${direction === 'up' ? '上移' : '下移'}`,
      })
    } catch (submitError) {
      notify({
        type: 'error',
        title: '移动失败',
        message: submitError instanceof Error ? submitError.message : '移动失败',
      })
    } finally {
      setMovingId(null)
    }
  }

  const loadProjects = useCallback(async (options?: { force?: boolean }) => {
    if (status === 'loading') {
      return
    }
    setLoading(true)
    try {
      const payload = await fetchManagedProjectsCached<ProjectItem[]>(session, true, options)
      setItems(payload)
    } catch (loadError) {
      notify({
        type: 'error',
        title: '加载失败',
        message: loadError instanceof Error ? loadError.message : '加载失败',
      })
    } finally {
      setLoading(false)
    }
  }, [session, status, notify])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const loadStartupSummary = useCallback(async () => {
    const requestId = ++startupSummaryRequestRef.current
    setStartupSummaryLoading(true)
    setStartupSummaryError(false)
    try {
      const summary = await fetchWorkflowSummary(session)
      if (requestId !== startupSummaryRequestRef.current) return
      setStartupWorkflowsByProject(
        new Map(summary.projects.map((project) => [project.project_id, project.workflows]))
      )
    } catch {
      if (requestId !== startupSummaryRequestRef.current) return
      setStartupSummaryError(true)
    } finally {
      if (requestId === startupSummaryRequestRef.current) setStartupSummaryLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (status === 'loading') return
    void loadStartupSummary()
    return () => {
      startupSummaryRequestRef.current += 1
    }
  }, [loadStartupSummary, status])

  const refreshPageData = useCallback(async () => {
    await Promise.all([loadProjects({ force: true }), loadStartupSummary()])
  }, [loadProjects, loadStartupSummary])
  useHeaderRefresh(refreshPageData, { loading: loading || startupSummaryLoading })

  useEffect(() => {
    void loadOperatorOptions()
  }, [loadOperatorOptions])

  // Handle configure query param to auto-open context drawer
  useEffect(() => {
    const configureId = searchParams.get('configure')
    if (configureId) {
      const projectId = Number(configureId)
      const project = items.find((item) => item.id === projectId)
      if (project) {
        // Wait for items to be loaded, then open drawer
        setContextProjectId(projectId)
        setContextProjectName(project.name)
        setContextDrawerOpen(true)
      }
    }
  }, [searchParams, items])

  const onAddSingle = async () => {
    const normalizedName = addName.trim()
    if (!normalizedName) {
      notify({ type: 'error', title: '项目名称不能为空' })
      return
    }

    setSubmitting(true)
    startGlobalLoading('blocking')
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: normalizedName,
          brand_name: addBrandName.trim() || null,
          store_address: addStoreAddress.trim() || null,
          project_operator: serializeOperatorNames(addProjectOperators),
          assistant_operator: serializeOperatorNames(addAssistantOperators),
          commission_basis: addCommissionMode.trim() || null,
          commission_rate: isAddCashReceivedCommission
            ? null
            : addCommissionRate
              ? parseFloat(addCommissionRate)
              : null,
          project_tier: addProjectTier === TIER_NONE_VALUE ? null : addProjectTier,
          country: addCountry,
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setAddName('')
      setAddBrandName('')
      setAddStoreAddress('')
      setAddProjectOperators([])
      setAddAssistantOperators([])
      setAddCommissionMode('')
      setAddCommissionRate('')
      setAddProjectTier(TIER_NONE_VALUE)
      setAddCountry('US')
      setAddDialogOpen(false)
      clearProjectClientCaches()
      notify({ type: 'success', title: '项目已新增', message: normalizedName })
      await loadProjects()
    } catch (submitError) {
      notify({
        type: 'error',
        title: '新增项目失败',
        message: submitError instanceof Error ? submitError.message : '新增失败',
      })
    } finally {
      endGlobalLoading('blocking')
      setSubmitting(false)
    }
  }

  const onOpenEdit = (item: ProjectItem) => {
    setEditingItem(item)
    setEditName(item.name)
    setEditBrandName(item.brand_name ?? '')
    setEditStoreAddress(item.store_address ?? '')
    setEditProjectOperators(parseOperatorNames(item.project_operator))
    setEditAssistantOperators(parseOperatorNames(item.assistant_operator))
    setEditCommissionMode(item.commission_basis ?? '')
    const points = toCommissionPoints(item.commission_rate)
    setEditCommissionRate(points?.toString() ?? '')
    setEditIsActive(item.is_active)
    setEditProjectTier(item.project_tier ?? TIER_NONE_VALUE)
    setEditCountry(item.country ?? 'US')
    setEditShopIds(emptyShopIds())
    setEditOriginalShopIds(emptyShopIds())
    setShopLoadError(null)
    setEditDialogOpen(true)
    const requestId = ++shopLoadRequestRef.current
    setLoadingShopIds(true)
    void fetch(`${API_BASE}/api/v1/projects/${item.id}/shops`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await parseError(response))
        return (await response.json()) as ProjectShop[]
      })
      .then((shops) => {
        if (requestId !== shopLoadRequestRef.current) return
        const values = emptyShopIds()
        for (const shop of shops) values[shop.country] = shop.shop_id
        setEditShopIds(values)
        setEditOriginalShopIds(values)
      })
      .catch((error) => {
        if (requestId !== shopLoadRequestRef.current) return
        const message = error instanceof Error ? error.message : '加载失败'
        setShopLoadError(message)
        notify({ type: 'error', title: '加载 Shop ID 失败', message })
      })
      .finally(() => {
        if (requestId === shopLoadRequestRef.current) setLoadingShopIds(false)
      })
  }

  const saveShopIds = async (
    projectId: number,
    shopIds: Record<string, string>,
    originalShopIds: Record<string, string>
  ) => {
    for (const { value: country } of SHOP_COUNTRY_OPTIONS) {
      const shopId = shopIds[country].trim()
      const originalShopId = originalShopIds[country].trim()
      if (shopId === originalShopId) continue
      const url = `${API_BASE}/api/v1/projects/${projectId}/shops/${country}`
      if (!shopId && originalShopId) {
        const response = await fetch(url, { method: 'DELETE', headers: authHeaders() })
        if (!response.ok) throw new Error(await parseError(response))
        continue
      }
      if (!shopId) continue
      const response = await fetch(url, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_id: shopId }),
      })
      if (!response.ok) throw new Error(await parseError(response))
    }
  }


  const onEditSingle = async () => {
    if (!editingItem) {
      return
    }

    const normalizedName = editName.trim()
    if (!normalizedName) {
      notify({ type: 'error', title: '项目名称不能为空' })
      return
    }
    if (shopLoadError) {
      notify({ type: 'error', title: '无法保存项目', message: 'Shop ID 加载失败，请重试后再保存' })
      return
    }

    const projectId = editingItem.id
    const shopIds = { ...editShopIds }
    const originalShopIds = { ...editOriginalShopIds }
    setSubmitting(true)
    startGlobalLoading('blocking')
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: normalizedName,
          brand_name: editBrandName.trim() || null,
          store_address: editStoreAddress.trim() || null,
          project_operator: serializeOperatorNames(editProjectOperators),
          assistant_operator: serializeOperatorNames(editAssistantOperators),
          commission_basis: editCommissionMode.trim() || null,
          commission_rate: isEditCashReceivedCommission
            ? null
            : editCommissionRate
              ? parseFloat(editCommissionRate)
              : null,
          is_active: editIsActive,
          project_tier: editProjectTier === TIER_NONE_VALUE ? null : editProjectTier,
          country: editCountry,
        }),
      })
      if (!response.ok) throw new Error(await parseError(response))
      await saveShopIds(projectId, shopIds, originalShopIds)
      setEditDialogOpen(false)
      setEditingItem(null)
      setEditName('')
      setEditBrandName('')
      setEditStoreAddress('')
      setEditProjectOperators([])
      setEditAssistantOperators([])
      setEditCommissionMode('')
      setEditCommissionRate('')
      setEditProjectTier(TIER_NONE_VALUE)
      setEditShopIds(emptyShopIds())
      setEditOriginalShopIds(emptyShopIds())
      setEditCountry('US')
      clearProjectClientCaches()
      notify({ type: 'success', title: '项目已更新', message: normalizedName })
      await loadProjects({ force: true })
    } catch (submitError) {
      notify({
        type: 'error',
        title: '更新项目失败',
        message: submitError instanceof Error ? submitError.message : '更新失败',
      })
    } finally {
      endGlobalLoading('blocking')
      setSubmitting(false)
    }
  }


  return (
    <div className={styles.page} data-warm-project-info="true">
      <Tabs defaultValue="context" className={styles.tabs}>
        <div className={styles.tabBar}>
          <TabsList className={styles.tabList} aria-label="项目信息">
            <TabsTrigger className={styles.tabTrigger} value="basic">
              <FileText aria-hidden="true" />
              基础信息
            </TabsTrigger>
            <TabsTrigger className={styles.tabTrigger} value="context">
              <Settings aria-hidden="true" />
              项目明细
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="basic" className={styles.tabContent}>
          <section className={styles.panel} aria-label="项目资料">
            <header className={styles.panelHeader}>
              <div className={styles.panelLead}>
                <h2 className={styles.panelTitle}>项目资料</h2>
                <p className={styles.panelMeta}>维护项目主数据，支持单个新增与项目信息编辑。</p>
              </div>
              <div className={styles.actions}>
                {loading || startupSummaryLoading ? (
                  <span className={styles.refreshing} role="status">
                    正在刷新数据
                  </span>
                ) : null}
                <WarmButton
                  type="button"
                  variant="secondary"
                  className={styles.actionButton}
                  onClick={() => void Promise.all([loadProjects(), loadStartupSummary()])}
                  disabled={loading || startupSummaryLoading || submitting}
                >
                  {loading ? '刷新中...' : '刷新数据'}
                </WarmButton>
                <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                  <DialogTrigger asChild>
                    <WarmButton
                      type="button"
                      variant="primary"
                      className={styles.actionButton}
                      disabled={submitting}
                    >
                      <PlusCircle aria-hidden="true" />
                      单个新增
                    </WarmButton>
                  </DialogTrigger>
                  <DialogContent
                    aria-describedby="add-project-dialog-description"
                    className={styles.dialogSurface}
                  >
                    <span id="add-project-dialog-description" className="sr-only">
                      新增项目，一次仅新增一个项目名称
                    </span>
                    <DialogHeader>
                      <DialogTitle className={styles.dialogTitle}>新增项目</DialogTitle>
                      <DialogDescription className={styles.dialogDescription}>
                        一次仅新增一个项目名称，不支持批量导入。
                      </DialogDescription>
                    </DialogHeader>
                    <div className={styles.formGrid}>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-name" className={styles.formLabel}>
                          项目名称
                        </label>
                        <Input
                          id="project-add-name"
                          value={addName}
                          onChange={(e) => setAddName(e.target.value)}
                          placeholder="例如：宝勒3店"
                          disabled={submitting}
                          className={styles.formInput}
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-brand" className={styles.formLabel}>
                          品牌名称
                        </label>
                        <Input
                          id="project-add-brand"
                          value={addBrandName}
                          onChange={(e) => setAddBrandName(e.target.value)}
                          placeholder="例如：BelieveBoy"
                          disabled={submitting}
                          className={styles.formInput}
                        />
                      </div>
                      <div className={`${styles.formField} ${styles.formFieldWide}`}>
                        <label htmlFor="project-add-operator" className={styles.formLabel}>
                          运营
                        </label>
                        <div className={styles.inlineFieldRow}>
                          <OperatorMultiSelect
                            buttonId="project-add-operator"
                            value={addProjectOperators}
                            options={operatorOptions}
                            placeholder="选择一个或多个运营"
                            disabled={submitting}
                            onChange={setAddProjectOperators}
                          />
                          <WarmButton
                            type="button"
                            variant="secondary"
                            onClick={() => setAddProjectOperators([])}
                            disabled={submitting || addProjectOperators.length === 0}
                          >
                            清空
                          </WarmButton>
                        </div>
                        {addProjectOperators.length > 0 ? (
                          <p className={styles.selectedNames}>
                            已选择：{addProjectOperators.join('、')}
                          </p>
                        ) : null}
                      </div>
                      <div className={`${styles.formField} ${styles.formFieldWide}`}>
                        <label htmlFor="project-add-assistant-operator" className={styles.formLabel}>
                          助理运营
                        </label>
                        <div className={styles.inlineFieldRow}>
                          <OperatorMultiSelect
                            buttonId="project-add-assistant-operator"
                            value={addAssistantOperators}
                            options={operatorOptions}
                            placeholder="选择一个或多个助理运营"
                            disabled={submitting}
                            onChange={setAddAssistantOperators}
                          />
                          <WarmButton
                            type="button"
                            variant="secondary"
                            onClick={() => setAddAssistantOperators([])}
                            disabled={submitting || addAssistantOperators.length === 0}
                          >
                            清空
                          </WarmButton>
                        </div>
                        {addAssistantOperators.length > 0 ? (
                          <p className={styles.selectedNames}>
                            已选择：{addAssistantOperators.join('、')}
                          </p>
                        ) : null}
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-commission-mode" className={styles.formLabel}>
                          佣金方式
                        </label>
                        <WarmSelect
                          id="project-add-commission-mode"
                          label="佣金方式"
                          value={addCommissionMode}
                          options={COMMISSION_BASIS_OPTIONS}
                          onChange={setAddCommissionMode}
                          placeholder="选择佣金方式"
                          disabled={submitting}
                          className={styles.formSelect}
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-commission-rate" className={styles.formLabel}>
                          佣金点数
                        </label>
                        <Input
                          id="project-add-commission-rate"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={addCommissionRate}
                          onChange={(e) => setAddCommissionRate(e.target.value)}
                          placeholder={
                            isAddCashReceivedCommission
                              ? '平台回款按回款率阶梯自动计算'
                              : '例如：5（表示 5%）'
                          }
                          disabled={submitting || isAddCashReceivedCommission}
                          className={styles.formInput}
                        />
                        {isAddCashReceivedCommission ? (
                          <p className={styles.fieldHint}>
                            回款率阶梯：40%-50%→7%，50%-60%→10%，60%-70%→13%，70%以上→15%
                          </p>
                        ) : null}
                      </div>
                      <div className={`${styles.formField} ${styles.formFieldWide}`}>
                        <label htmlFor="project-add-address" className={styles.formLabel}>
                          店铺地址
                        </label>
                        <Input
                          id="project-add-address"
                          value={addStoreAddress}
                          onChange={(e) => setAddStoreAddress(e.target.value)}
                          placeholder="例如：https://www.amazon.com/..."
                          disabled={submitting}
                          className={styles.formInput}
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-tier" className={styles.formLabel}>
                          项目等级
                        </label>
                        <WarmSelect
                          id="project-add-tier"
                          label="项目等级"
                          value={addProjectTier}
                          options={TIER_SELECT_OPTIONS}
                          onChange={setAddProjectTier}
                          disabled={submitting}
                          className={styles.formSelect}
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor="project-add-country" className={styles.formLabel}>
                          站点
                        </label>
                        <WarmSelect
                          id="project-add-country"
                          label="站点"
                          value={addCountry}
                          options={PROJECT_COUNTRY_OPTIONS}
                          onChange={setAddCountry}
                          placeholder="选择站点"
                          disabled={submitting}
                          className={styles.formSelect}
                        />
                      </div>
                    </div>
                    <DialogFooter className={styles.dialogFooter}>
                      <WarmButton
                        type="button"
                        variant="secondary"
                        onClick={() => setAddDialogOpen(false)}
                        disabled={submitting}
                      >
                        取消
                      </WarmButton>
                      <WarmButton
                        type="button"
                        variant="primary"
                        onClick={() => void onAddSingle()}
                        disabled={submitting}
                      >
                        {submitting ? '提交中...' : '确认新增'}
                      </WarmButton>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </header>

            <div className={styles.tableWrap}>
              <table className={styles.dataTable} aria-label="项目资料列表">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 80 }}>
                      ID
                    </th>
                    <th scope="col">项目名称</th>
                    <th scope="col" style={{ width: 110 }}>
                      站点
                    </th>
                    <th scope="col">品牌名称</th>
                    <th scope="col">运营</th>
                    <th scope="col">助理运营</th>
                    <th scope="col">佣金方式</th>
                    <th scope="col" className={styles.numericCell}>
                      佣金点数
                    </th>
                    <th scope="col" style={{ width: 140 }}>
                      店铺地址
                    </th>
                    <th scope="col" style={{ width: 90 }}>
                      状态
                    </th>
                    <th scope="col" style={{ width: 110 }}>
                      启动状态
                    </th>
                    <th scope="col" style={{ width: 100 }}>
                      项目等级
                    </th>
                    <th scope="col" style={{ width: 130 }}>
                      排序
                    </th>
                    <th scope="col" className={styles.numericCell} style={{ width: 110 }}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {showSkeleton ? (
                    Array.from({ length: 6 }).map((_, index) => (
                      <tr key={`skeleton-${index}`}>
                        <td colSpan={14}>
                          <Skeleton className={styles.skeleton} />
                        </td>
                      </tr>
                    ))
                  ) : items.length === 0 ? (
                    <tr>
                      <td className={styles.stateCell} colSpan={14}>
                        暂无项目数据，请先新增一个项目。
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => (
                      <tr key={item.id}>
                        <td className={styles.idCell}>{item.id}</td>
                        <td className={styles.nameCell}>
                          <div className={styles.projectIdentity}>
                            {item.is_active && item.has_context && (
                              <span
                                className={styles.contextDot}
                                title="已配置项目背景"
                                aria-label="已配置项目背景"
                              />
                            )}
                            <span className={styles.projectName}>{item.name}</span>
                          </div>
                        </td>
                        <td>{item.country_name ?? getCountryLabel(item.country)}</td>
                        <td>{item.brand_name || '-'}</td>
                        <td className={styles.wrapCell}>{item.project_operator || '-'}</td>
                        <td className={styles.wrapCell}>{item.assistant_operator || '-'}</td>
                        <td>
                          {item.commission_basis
                            ? (COMMISSION_BASIS_LABEL[item.commission_basis] ??
                              item.commission_basis)
                            : '-'}
                        </td>
                        <td className={styles.numericCell}>
                          {item.commission_basis === 'cash_received'
                            ? '阶梯(7/10/13/15%)'
                            : (toCommissionPoints(item.commission_rate) ?? '-')}
                        </td>
                        <td className={styles.addressCell} title={item.store_address || ''}>
                          {item.store_address ? `${item.store_address.slice(0, 15)}...` : '-'}
                        </td>
                        <td>
                          <ProjectStatusPill active={item.is_active} />
                        </td>
                        <td>
                          {startupSummaryLoading ? (
                            <span className={styles.loadingStatus} role="status">
                              加载中
                            </span>
                          ) : startupSummaryError ? (
                            <span className={styles.loadingStatus} title="启动状态加载失败">
                              -
                            </span>
                          ) : (
                            <StartupStatusPill
                              workflows={startupWorkflowsByProject.get(item.id) ?? []}
                            />
                          )}
                        </td>
                        <td>
                          {item.project_tier ? (
                            <WarmBadge className={styles.tierBadge}>
                              {TIER_LABEL[item.project_tier] || item.project_tier}
                            </WarmBadge>
                          ) : (
                            <span className={styles.loadingStatus}>-</span>
                          )}
                        </td>
                        <td>
                          <div className={styles.rowActions}>
                            <WarmIconButton
                              type="button"
                              onClick={() => void moveProject(item.id, 'up')}
                              disabled={submitting || movingId === item.id}
                              aria-label={`上移项目 ${item.name}`}
                              title="上移"
                              className={styles.iconButton}
                            >
                              <ChevronUp aria-hidden="true" />
                            </WarmIconButton>
                            <WarmIconButton
                              type="button"
                              onClick={() => void moveProject(item.id, 'down')}
                              disabled={submitting || movingId === item.id}
                              aria-label={`下移项目 ${item.name}`}
                              title="下移"
                              className={styles.iconButton}
                            >
                              <ChevronDown aria-hidden="true" />
                            </WarmIconButton>
                          </div>
                        </td>
                        <td>
                          <div className={styles.rowActions}>
                            <WarmIconButton
                              type="button"
                              onClick={() => openContextDrawer(item)}
                              disabled={submitting}
                              aria-label={`项目背景配置 ${item.name}`}
                              title="项目背景配置"
                              className={styles.iconButton}
                            >
                              <Settings aria-hidden="true" />
                            </WarmIconButton>
                            <WarmIconButton
                              type="button"
                              onClick={() => onOpenEdit(item)}
                              disabled={submitting}
                              aria-label={`编辑项目 ${item.name}`}
                              title="编辑"
                              className={styles.iconButton}
                            >
                              <PencilLine aria-hidden="true" />
                            </WarmIconButton>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="context" className={styles.tabContent}>
          <ProjectContextTab />
        </TabsContent>
      </Tabs>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent
          aria-describedby="edit-project-dialog-description"
          className={styles.dialogSurface}
        >
          <span id="edit-project-dialog-description" className="sr-only">
            编辑项目信息
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>编辑项目信息</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              可修改项目名称、品牌名称、运营、助理运营、佣金方式、佣金点数与店铺地址，不调整排序。
            </DialogDescription>
          </DialogHeader>
          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <label htmlFor="project-edit-name" className={styles.formLabel}>
                项目名称
              </label>
              <Input
                id="project-edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="输入新的项目名称"
                disabled={submitting}
                className={styles.formInput}
              />
            </div>
            <div className={styles.formField}>
              <label htmlFor="project-edit-brand" className={styles.formLabel}>
                品牌名称
              </label>
              <Input
                id="project-edit-brand"
                value={editBrandName}
                onChange={(e) => setEditBrandName(e.target.value)}
                placeholder="输入品牌名称"
                disabled={submitting}
                className={styles.formInput}
              />
            </div>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label htmlFor="project-edit-operator" className={styles.formLabel}>
                运营
              </label>
              <div className={styles.inlineFieldRow}>
                <OperatorMultiSelect
                  buttonId="project-edit-operator"
                  value={editProjectOperators}
                  options={operatorOptions}
                  placeholder="选择一个或多个运营"
                  disabled={submitting}
                  onChange={setEditProjectOperators}
                />
                <WarmButton
                  type="button"
                  variant="secondary"
                  onClick={() => setEditProjectOperators([])}
                  disabled={submitting || editProjectOperators.length === 0}
                >
                  清空
                </WarmButton>
              </div>
              {editProjectOperators.length > 0 ? (
                <p className={styles.selectedNames}>已选择：{editProjectOperators.join('、')}</p>
              ) : null}
            </div>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label htmlFor="project-edit-assistant-operator" className={styles.formLabel}>
                助理运营
              </label>
              <div className={styles.inlineFieldRow}>
                <OperatorMultiSelect
                  buttonId="project-edit-assistant-operator"
                  value={editAssistantOperators}
                  options={operatorOptions}
                  placeholder="选择一个或多个助理运营"
                  disabled={submitting}
                  onChange={setEditAssistantOperators}
                />
                <WarmButton
                  type="button"
                  variant="secondary"
                  onClick={() => setEditAssistantOperators([])}
                  disabled={submitting || editAssistantOperators.length === 0}
                >
                  清空
                </WarmButton>
              </div>
              {editAssistantOperators.length > 0 ? (
                <p className={styles.selectedNames}>
                  已选择：{editAssistantOperators.join('、')}
                </p>
              ) : null}
            </div>
            <div className={styles.formField}>
              <label htmlFor="project-edit-commission-mode" className={styles.formLabel}>
                佣金方式
              </label>
              <WarmSelect
                id="project-edit-commission-mode"
                label="佣金方式"
                value={editCommissionMode}
                options={COMMISSION_BASIS_OPTIONS}
                onChange={setEditCommissionMode}
                placeholder="选择佣金方式"
                disabled={submitting}
                className={styles.formSelect}
              />
            </div>
            <div className={styles.formField}>
              <label htmlFor="project-edit-commission-rate" className={styles.formLabel}>
                佣金点数
              </label>
              <Input
                id="project-edit-commission-rate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={editCommissionRate}
                onChange={(e) => setEditCommissionRate(e.target.value)}
                placeholder={
                  isEditCashReceivedCommission
                    ? '平台回款按回款率阶梯自动计算'
                    : '例如：5（表示 5%）'
                }
                disabled={submitting || isEditCashReceivedCommission}
                className={styles.formInput}
              />
              {isEditCashReceivedCommission ? (
                <p className={styles.fieldHint}>
                  回款率阶梯：40%-50%→7%，50%-60%→10%，60%-70%→13%，70%以上→15%
                </p>
              ) : null}
            </div>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label htmlFor="project-edit-address" className={styles.formLabel}>
                店铺地址
              </label>
              <Input
                id="project-edit-address"
                value={editStoreAddress}
                onChange={(e) => setEditStoreAddress(e.target.value)}
                placeholder="输入店铺地址"
                disabled={submitting}
                className={styles.formInput}
              />
            </div>
            <div className={styles.formField}>
              <label htmlFor="project-edit-tier" className={styles.formLabel}>
                项目等级
              </label>
              <WarmSelect
                id="project-edit-tier"
                label="项目等级"
                value={editProjectTier}
                options={TIER_SELECT_OPTIONS}
                onChange={setEditProjectTier}
                disabled={submitting}
                className={styles.formSelect}
              />
              {!editIsActive ? (
                <p className={styles.fieldHint}>
                  项目已停用：如需去掉列表中的 T1-T4 标签，请选择「未分级」。
                </p>
              ) : null}
            </div>
            <div className={styles.formField}>
              <label htmlFor="project-edit-country" className={styles.formLabel}>
                站点
              </label>
              <WarmSelect
                id="project-edit-country"
                label="站点"
                value={editCountry}
                options={PROJECT_COUNTRY_OPTIONS}
                onChange={setEditCountry}
                placeholder="选择站点"
                disabled={submitting}
                className={styles.formSelect}
              />
            </div>
            <div className={styles.shopSection}>
              <span className={styles.formLabel}>店铺映射</span>
              <p className={styles.fieldHint}>
                每个站点对应一个 Shop ID；清空已有值将删除该站点映射。
              </p>
              <div className={styles.shopGrid}>
                {SHOP_COUNTRY_OPTIONS.map((option) => (
                  <div key={`shop-id-edit-${option.value}`} className={styles.formField}>
                    <label
                      htmlFor={`project-edit-shop-id-${option.value}`}
                      className={styles.formLabel}
                    >
                      {getCountryLabel(option.value)} Shop ID
                    </label>
                    <Input
                      id={`project-edit-shop-id-${option.value}`}
                      value={editShopIds[option.value] ?? ''}
                      onChange={(event) =>
                        setEditShopIds((current) => ({
                          ...current,
                          [option.value]: event.target.value,
                        }))
                      }
                      placeholder={`输入 ${option.value} 站 Shop ID`}
                      disabled={submitting || loadingShopIds}
                      maxLength={64}
                      className={styles.formInput}
                    />
                  </div>
                ))}
              </div>
              {loadingShopIds ? (
                <p className={styles.fieldHint} role="status">
                  正在加载店铺映射...
                </p>
              ) : null}
              {shopLoadError ? <p className={styles.fieldError}>{shopLoadError}</p> : null}
            </div>
            <div className={styles.switchRow}>
              <Switch
                id="project-edit-is-active"
                checked={editIsActive}
                onCheckedChange={setEditIsActive}
                disabled={submitting}
                className={styles.switchControl}
              />
              <label htmlFor="project-edit-is-active" className={styles.switchLabel}>
                启用项目
              </label>
              <span className={styles.fieldHint}>（停用后，其他页面将不再显示该项目）</span>
            </div>
          </div>
          <DialogFooter className={styles.dialogFooter}>
            <WarmButton
              type="button"
              variant="secondary"
              onClick={() => setEditDialogOpen(false)}
              disabled={submitting}
            >
              取消
            </WarmButton>
            <WarmButton
              type="button"
              variant="primary"
              onClick={() => void onEditSingle()}
              disabled={submitting || !editingItem}
            >
              {submitting ? '保存中...' : '保存修改'}
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {contextProjectId && (
        <ProjectContextDrawer
          projectId={contextProjectId}
          projectName={contextProjectName}
          open={contextDrawerOpen}
          onOpenChange={setContextDrawerOpen}
          onSuccess={() => {
            void loadProjects()
          }}
        />
      )}
    </div>
  )
}
