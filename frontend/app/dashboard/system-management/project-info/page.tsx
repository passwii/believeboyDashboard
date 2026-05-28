'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronUp, ChevronsUpDown, PencilLine, PlusCircle, Settings, FileText } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { ProjectContextDrawer } from '@/components/dashboard/project-context/project-context-drawer'
import { ProjectContextTab } from '@/components/dashboard/project-context/project-context-tab'
import {
  clearProjectClientCaches,
  fetchManagedProjectsCached,
  fetchProjectOperatorOptionsCached,
} from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'

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

const TIER_BADGE_CLASS: Record<string, string> = {
  T1: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400 border-red-200 dark:border-red-800',
  T2: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  T3: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  T4: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-400 border-slate-200 dark:border-slate-800',
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
        <Button
          type="button"
          id={buttonId}
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !summary && 'text-muted-foreground')}
        >
          <span className="truncate">{summary || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-3">
        <div className="space-y-2">
          {options.length > 0 ? (
            options.map((name) => {
              const checked = value.includes(name)
              return (
                <label
                  key={`operator-multi-${name}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => onChange(toggleOperatorName(value, name))}
                  />
                  <span className="flex-1">{name}</span>
                </label>
              )
            })
          ) : (
            <p className="px-2 py-1 text-sm text-muted-foreground">暂无可选运营</p>
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

export default function StoreInfoPage() {
  const { notify } = useNotifications()
  const { startGlobalLoading, endGlobalLoading } = useGlobalLoading()
  const { data: session, status } = useSession()
  const searchParams = useSearchParams()
  const [items, setItems] = useState<ProjectItem[]>([])
  const [loading, setLoading] = useState(false)
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
  const [addProjectTier, setAddProjectTier] = useState('')

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
  const [editProjectTier, setEditProjectTier] = useState('')

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
      notify({ type: 'success', title: '项目已移动', message: `项目已${direction === 'up' ? '上移' : '下移'}` })
    } catch (submitError) {
      notify({ type: 'error', title: '移动失败', message: submitError instanceof Error ? submitError.message : '移动失败' })
    } finally {
      setMovingId(null)
    }
  }

  const loadProjects = useCallback(async () => {
    if (status === 'loading') {
      return
    }
    setLoading(true)
    try {
      const payload = await fetchManagedProjectsCached<ProjectItem[]>(session, true)
      setItems(payload)
    } catch (loadError) {
      notify({ type: 'error', title: '加载失败', message: loadError instanceof Error ? loadError.message : '加载失败' })
    } finally {
      setLoading(false)
    }
  }, [session, status, notify])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

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
          commission_rate: isAddCashReceivedCommission ? null : (addCommissionRate ? parseFloat(addCommissionRate) : null),
          project_tier: addProjectTier || null,
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
      setAddProjectTier('')
      setAddDialogOpen(false)
      clearProjectClientCaches()
      notify({ type: 'success', title: '项目已新增', message: normalizedName })
      await loadProjects()
    } catch (submitError) {
      notify({ type: 'error', title: '新增项目失败', message: submitError instanceof Error ? submitError.message : '新增失败' })
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
    setEditProjectTier(item.project_tier ?? '')
    setEditDialogOpen(true)
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

    setSubmitting(true)
    startGlobalLoading('blocking')
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${editingItem.id}`, {
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
          commission_rate: isEditCashReceivedCommission ? null : (editCommissionRate ? parseFloat(editCommissionRate) : null),
          is_active: editIsActive,
          project_tier: editProjectTier || null,
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setEditDialogOpen(false)
      setEditingItem(null)
      setEditBrandName('')
      setEditStoreAddress('')
      setEditProjectOperators([])
      setEditAssistantOperators([])
      setEditCommissionMode('')
      setEditCommissionRate('')
      setEditProjectTier('')
      clearProjectClientCaches()
      notify({ type: 'success', title: '项目已更新', message: normalizedName })
      await loadProjects()
    } catch (submitError) {
      notify({ type: 'error', title: '更新项目失败', message: submitError instanceof Error ? submitError.message : '更新失败' })
    } finally {
      endGlobalLoading('blocking')
      setSubmitting(false)
    }
  }


  return (
    <div className="w-full h-full">
      <Tabs defaultValue="context" className="h-full flex flex-col">
        <div className="mb-4">
          <TabsList>
            <TabsTrigger value="basic">
              <FileText className="mr-2 h-4 w-4" />
              基础信息
            </TabsTrigger>
            <TabsTrigger value="context">
              <Settings className="mr-2 h-4 w-4" />
              项目明细
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="basic" className="flex-1 mt-0">
      <DataTableCard className="h-full flex flex-col overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)] dark:border-border/80 dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <DataTableCardHeader className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <Badge variant="outline" className="w-fit rounded-md">数据管理</Badge>
            <p className="text-sm text-muted-foreground">维护项目主数据，支持单个新增与项目信息编辑。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void loadProjects()} disabled={loading || submitting}>
              {loading ? '刷新中...' : '刷新数据'}
            </Button>
            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
              <DialogTrigger asChild>
                <Button type="button" disabled={submitting}>
                  <PlusCircle className="mr-2 h-4 w-4" />
                  单个新增
                </Button>
              </DialogTrigger>
              <DialogContent aria-describedby="add-project-dialog-description" className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
                <span id="add-project-dialog-description" className="sr-only">新增项目，一次仅新增一个项目名称</span>
                <DialogHeader>
                  <DialogTitle>新增项目</DialogTitle>
                  <DialogDescription>一次仅新增一个项目名称，不支持批量导入。</DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <label htmlFor="project-add-name" className="text-sm font-medium text-foreground">
                    项目名称
                  </label>
                  <Input
                    id="project-add-name"
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="例如：宝勒3店"
                    disabled={submitting}
                  />
                  <label htmlFor="project-add-brand" className="text-sm font-medium text-foreground">
                    品牌名称
                  </label>
                  <Input
                    id="project-add-brand"
                    value={addBrandName}
                    onChange={(e) => setAddBrandName(e.target.value)}
                    placeholder="例如：BelieveBoy"
                    disabled={submitting}
                  />
                  <label htmlFor="project-add-operator" className="text-sm font-medium text-foreground">
                    运营
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <OperatorMultiSelect
                        buttonId="project-add-operator"
                        value={addProjectOperators}
                        options={operatorOptions}
                        placeholder="选择一个或多个运营"
                        disabled={submitting}
                        onChange={setAddProjectOperators}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setAddProjectOperators([])}
                      disabled={submitting || addProjectOperators.length === 0}
                    >
                      清空
                    </Button>
                  </div>
                  {addProjectOperators.length > 0 ? (
                    <p className="text-xs text-muted-foreground">已选择：{addProjectOperators.join('、')}</p>
                  ) : null}
                  <label htmlFor="project-add-assistant-operator" className="text-sm font-medium text-foreground">
                    助理运营
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <OperatorMultiSelect
                        buttonId="project-add-assistant-operator"
                        value={addAssistantOperators}
                        options={operatorOptions}
                        placeholder="选择一个或多个助理运营"
                        disabled={submitting}
                        onChange={setAddAssistantOperators}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setAddAssistantOperators([])}
                      disabled={submitting || addAssistantOperators.length === 0}
                    >
                      清空
                    </Button>
                  </div>
                  {addAssistantOperators.length > 0 ? (
                    <p className="text-xs text-muted-foreground">已选择：{addAssistantOperators.join('、')}</p>
                  ) : null}
                  <label htmlFor="project-add-commission-mode" className="text-sm font-medium text-foreground">
                    佣金方式
                  </label>
                  <Select value={addCommissionMode} onValueChange={setAddCommissionMode} disabled={submitting}>
                    <SelectTrigger id="project-add-commission-mode">
                      <SelectValue placeholder="选择佣金方式" />
                    </SelectTrigger>
                    <SelectContent>
                      {COMMISSION_BASIS_OPTIONS.map((option) => (
                        <SelectItem key={`commission-basis-add-${option.value}`} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label htmlFor="project-add-commission-rate" className="text-sm font-medium text-foreground">
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
                    placeholder={isAddCashReceivedCommission ? '平台回款按回款率阶梯自动计算' : '例如：5（表示 5%）'}
                    disabled={submitting || isAddCashReceivedCommission}
                  />
                  {isAddCashReceivedCommission ? (
                    <p className="text-xs text-muted-foreground">回款率阶梯：40%-50%→7%，50%-60%→10%，60%-70%→13%，70%以上→15%</p>
                  ) : null}
                  <label htmlFor="project-add-address" className="text-sm font-medium text-foreground">
                    店铺地址
                  </label>
                  <Input
                    id="project-add-address"
                    value={addStoreAddress}
                    onChange={(e) => setAddStoreAddress(e.target.value)}
                    placeholder="例如：https://www.amazon.com/..."
                    disabled={submitting}
                  />
                  <label htmlFor="project-add-tier" className="text-sm font-medium text-foreground">
                    项目等级
                  </label>
                  <Select value={addProjectTier} onValueChange={setAddProjectTier} disabled={submitting}>
                    <SelectTrigger id="project-add-tier">
                      <SelectValue placeholder="选择项目等级（可选）" />
                    </SelectTrigger>
                    <SelectContent>
                      {TIER_OPTIONS.map((option) => (
                        <SelectItem key={`tier-add-${option.value}`} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)} disabled={submitting}>
                    取消
                  </Button>
                  <Button type="button" onClick={() => void onAddSingle()} disabled={submitting}>
                    {submitting ? '提交中...' : '确认新增'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </DataTableCardHeader>
        <DataTableCardBody className="flex-1 min-h-0">
          <div className="h-full overflow-auto relative">
            <RefreshProgressBar refreshing={isRefreshing}>
              <table className="w-full border-separate border-spacing-0 caption-bottom text-sm">
              <thead className="[&_tr]:border-b-0">
                <tr className="border-b border-border/70 shadow-sm">
                  <th className="sticky top-0 z-20 h-12 w-[80px] border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">ID</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">项目名称</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">品牌名称</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">运营</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">助理运营</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">佣金方式</th>
                  <th className="sticky top-0 z-20 h-12 border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">佣金点数</th>
                  <th className="sticky top-0 z-20 h-12 w-[120px] border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">店铺地址</th>
                  <th className="sticky top-0 z-20 h-12 w-[80px] border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">状态</th>
                  <th className="sticky top-0 z-20 h-12 w-[80px] border-b border-r border-border/60 bg-background px-4 text-left align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">项目等级</th>
                  <th className="sticky top-0 z-20 h-12 w-[140px] border-b border-border/60 bg-background px-4 text-center align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">排序</th>
                  <th className="sticky top-0 z-20 h-12 w-[100px] border-b border-border/60 bg-background px-4 text-right align-middle font-medium text-muted-foreground dark:bg-[hsl(var(--surface-panel))]">操作</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
              {showSkeleton ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <tr key={`skeleton-${index}`} className="border-b transition-colors hover:bg-muted/50 dark:hover:bg-[hsl(var(--surface-strong)/0.35)]">
                    <td colSpan={13} className="p-4 align-middle">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : items.length === 0 ? (
                <EmptyState colSpan={13} message="暂无项目数据，请先新增一个项目。" />
              ) : (
                  items.map((item) => (
                    <tr key={item.id} className="border-b transition-colors hover:bg-muted/50 dark:hover:bg-[hsl(var(--surface-strong)/0.35)]">
                      <td className="border-b border-r border-border/60 p-4 align-middle text-muted-foreground">{item.id}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">
                        <div className="flex items-center gap-2">
                          {item.has_context && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-green-500"
                              title="已配置项目背景"
                            />
                          )}
                          <span className="font-medium text-foreground truncate">{item.name}</span>
                        </div>
                      </td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">{item.brand_name || '-'}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle whitespace-pre-wrap break-words">{item.project_operator || '-'}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle whitespace-pre-wrap break-words">{item.assistant_operator || '-'}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">{item.commission_basis ? COMMISSION_BASIS_LABEL[item.commission_basis] ?? item.commission_basis : '-'}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">{item.commission_basis === 'cash_received' ? '阶梯(7/10/13/15%)' : (toCommissionPoints(item.commission_rate) ?? '-')}</td>
                      <td className="border-b border-r border-border/60 p-4 align-middle max-w-[120px] truncate" title={item.store_address || ''}>
                        {item.store_address ? `${item.store_address.slice(0, 15)}...` : '-'}
                      </td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">
                        <Badge
                          variant={item.is_active ? 'default' : 'secondary'}
                          className={cn(
                            'text-xs font-medium',
                            item.is_active
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400 border-green-200 dark:border-green-800'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {item.is_active ? '启用' : '停用'}
                        </Badge>
                      </td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">
                        {item.project_tier ? (
                          <Badge
                            variant="outline"
                            className={cn('text-xs font-medium', TIER_BADGE_CLASS[item.project_tier] || 'bg-muted text-muted-foreground')}
                          >
                            {TIER_LABEL[item.project_tier] || item.project_tier}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="border-b border-r border-border/60 p-4 align-middle">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => void moveProject(item.id, 'up')}
                            disabled={submitting || movingId === item.id}
                            aria-label={`上移项目 ${item.name}`}
                            title="上移"
                            className="h-7 w-7"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => void moveProject(item.id, 'down')}
                            disabled={submitting || movingId === item.id}
                            aria-label={`下移项目 ${item.name}`}
                            title="下移"
                            className="h-7 w-7"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                      <td className="border-b border-border/60 p-4 align-middle text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => openContextDrawer(item)}
                            disabled={submitting}
                            aria-label={`项目背景配置 ${item.name}`}
                            title="项目背景配置"
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => onOpenEdit(item)}
                            disabled={submitting}
                            aria-label={`编辑项目 ${item.name}`}
                            title="编辑"
                          >
                            <PencilLine className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
            </RefreshProgressBar>
          </div>
        </DataTableCardBody>
      </DataTableCard>
        </TabsContent>

        <TabsContent value="context" className="flex-1 mt-0">
          <ProjectContextTab />
        </TabsContent>
      </Tabs>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent aria-describedby="edit-project-dialog-description" className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <span id="edit-project-dialog-description" className="sr-only">编辑项目信息</span>
          <DialogHeader>
            <DialogTitle>编辑项目信息</DialogTitle>
            <DialogDescription>可修改项目名称、品牌名称、运营、助理运营、佣金方式、佣金点数与店铺地址，不调整排序。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label htmlFor="project-edit-name" className="text-sm font-medium text-foreground">
              项目名称
            </label>
            <Input
              id="project-edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="输入新的项目名称"
              disabled={submitting}
            />
            <label htmlFor="project-edit-brand" className="text-sm font-medium text-foreground">
              品牌名称
            </label>
            <Input
              id="project-edit-brand"
              value={editBrandName}
              onChange={(e) => setEditBrandName(e.target.value)}
              placeholder="输入品牌名称"
              disabled={submitting}
            />
            <label htmlFor="project-edit-operator" className="text-sm font-medium text-foreground">
              运营
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <OperatorMultiSelect
                  buttonId="project-edit-operator"
                  value={editProjectOperators}
                  options={operatorOptions}
                  placeholder="选择一个或多个运营"
                  disabled={submitting}
                  onChange={setEditProjectOperators}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditProjectOperators([])}
                disabled={submitting || editProjectOperators.length === 0}
              >
                清空
              </Button>
            </div>
            {editProjectOperators.length > 0 ? (
              <p className="text-xs text-muted-foreground">已选择：{editProjectOperators.join('、')}</p>
            ) : null}
            <label htmlFor="project-edit-assistant-operator" className="text-sm font-medium text-foreground">
              助理运营
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <OperatorMultiSelect
                  buttonId="project-edit-assistant-operator"
                  value={editAssistantOperators}
                  options={operatorOptions}
                  placeholder="选择一个或多个助理运营"
                  disabled={submitting}
                  onChange={setEditAssistantOperators}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditAssistantOperators([])}
                disabled={submitting || editAssistantOperators.length === 0}
              >
                清空
              </Button>
            </div>
            {editAssistantOperators.length > 0 ? (
              <p className="text-xs text-muted-foreground">已选择：{editAssistantOperators.join('、')}</p>
            ) : null}
            <label htmlFor="project-edit-commission-mode" className="text-sm font-medium text-foreground">
              佣金方式
            </label>
            <Select value={editCommissionMode} onValueChange={setEditCommissionMode} disabled={submitting}>
              <SelectTrigger id="project-edit-commission-mode">
                <SelectValue placeholder="选择佣金方式" />
              </SelectTrigger>
              <SelectContent>
                {COMMISSION_BASIS_OPTIONS.map((option) => (
                  <SelectItem key={`commission-basis-edit-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label htmlFor="project-edit-commission-rate" className="text-sm font-medium text-foreground">
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
              placeholder={isEditCashReceivedCommission ? '平台回款按回款率阶梯自动计算' : '例如：5（表示 5%）'}
              disabled={submitting || isEditCashReceivedCommission}
            />
            {isEditCashReceivedCommission ? (
              <p className="text-xs text-muted-foreground">回款率阶梯：40%-50%→7%，50%-60%→10%，60%-70%→13%，70%以上→15%</p>
            ) : null}
            <label htmlFor="project-edit-address" className="text-sm font-medium text-foreground">
              店铺地址
            </label>
            <Input
              id="project-edit-address"
              value={editStoreAddress}
              onChange={(e) => setEditStoreAddress(e.target.value)}
              placeholder="输入店铺地址"
              disabled={submitting}
            />
            <label htmlFor="project-edit-tier" className="text-sm font-medium text-foreground">
              项目等级
            </label>
            <Select value={editProjectTier} onValueChange={setEditProjectTier} disabled={submitting}>
              <SelectTrigger id="project-edit-tier">
                <SelectValue placeholder="选择项目等级（可选）" />
              </SelectTrigger>
              <SelectContent>
                {TIER_OPTIONS.map((option) => (
                  <SelectItem key={`tier-edit-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-3 pt-2">
              <Switch
                id="project-edit-is-active"
                checked={editIsActive}
                onCheckedChange={setEditIsActive}
                disabled={submitting}
              />
              <label htmlFor="project-edit-is-active" className="text-sm font-medium cursor-pointer">
                启用项目
              </label>
              <span className="text-xs text-muted-foreground">（停用后，其他页面将不再显示该项目）</span>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="button" onClick={() => void onEditSingle()} disabled={submitting || !editingItem}>
              {submitting ? '保存中...' : '保存修改'}
            </Button>
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
