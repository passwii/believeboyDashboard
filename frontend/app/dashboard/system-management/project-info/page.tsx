'use client'

import { useCallback, useEffect, useState } from 'react'
import { PencilLine, PlusCircle } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useGlobalLoading } from '@/components/global-loading-provider'

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
  source_file: string | null
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

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown }
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
    return `请求失败 (${response.status})`
  } catch {
    const text = await response.text()
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
  const { withGlobalLoading } = useGlobalLoading()
  const { data: session, status } = useSession()
  const [items, setItems] = useState<ProjectItem[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [operatorOptions, setOperatorOptions] = useState<string[]>([])

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addBrandName, setAddBrandName] = useState('')
  const [addStoreAddress, setAddStoreAddress] = useState('')
  const [addProjectOperator, setAddProjectOperator] = useState('')
  const [addAssistantOperator, setAddAssistantOperator] = useState('')
  const [addCommissionMode, setAddCommissionMode] = useState('')
  const [addCommissionRate, setAddCommissionRate] = useState('')

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ProjectItem | null>(null)
  const [editName, setEditName] = useState('')
  const [editBrandName, setEditBrandName] = useState('')
  const [editStoreAddress, setEditStoreAddress] = useState('')
  const [editProjectOperator, setEditProjectOperator] = useState('')
  const [editAssistantOperator, setEditAssistantOperator] = useState('')
  const [editCommissionMode, setEditCommissionMode] = useState('')
  const [editCommissionRate, setEditCommissionRate] = useState('')
  const isAddCashReceivedCommission = addCommissionMode === 'cash_received'
  const isEditCashReceivedCommission = editCommissionMode === 'cash_received'

  const loadOperatorOptions = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/operator-options`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as string[]
      setOperatorOptions(payload)
    } catch {
      setOperatorOptions([])
    }
  }, [])

  const loadProjects = useCallback(async () => {
    if (status === 'loading') {
      return
    }
    await withGlobalLoading(async () => {
      setLoading(true)
      setError(null)
      try {
        const headers: Record<string, string> = { ...authHeaders() }
        if (session?.user?.isAdmin) {
          headers['X-Is-Admin'] = 'true'
        }
        const operatorName = session?.user?.operatorNameZh?.trim()
        if (operatorName) {
          headers['X-Operator'] = encodeURIComponent(operatorName)
        }

        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
          headers,
          cache: 'no-store',
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as ProjectItem[]
        setItems(payload)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '加载失败')
      } finally {
        setLoading(false)
      }
    })
  }, [session?.user?.isAdmin, session?.user?.operatorNameZh, status, withGlobalLoading])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    void loadOperatorOptions()
  }, [loadOperatorOptions])

  const onAddSingle = async () => {
    const normalizedName = addName.trim()
    if (!normalizedName) {
      setError('项目名称不能为空')
      return
    }

    setSubmitting(true)
    setError(null)
    setSuccessMessage(null)
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
          project_operator: addProjectOperator.trim() || null,
          assistant_operator: addAssistantOperator.trim() || null,
          commission_basis: addCommissionMode.trim() || null,
          commission_rate: isAddCashReceivedCommission ? null : (addCommissionRate ? parseFloat(addCommissionRate) : null),
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setAddName('')
      setAddBrandName('')
      setAddStoreAddress('')
      setAddProjectOperator('')
      setAddAssistantOperator('')
      setAddCommissionMode('')
      setAddCommissionRate('')
      setAddDialogOpen(false)
      setSuccessMessage(`已新增项目：${normalizedName}`)
      await loadProjects()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '新增失败')
    } finally {
      setSubmitting(false)
    }
  }

  const onOpenEdit = (item: ProjectItem) => {
    setEditingItem(item)
    setEditName(item.name)
    setEditBrandName(item.brand_name ?? '')
    setEditStoreAddress(item.store_address ?? '')
    setEditProjectOperator(item.project_operator ?? '')
    setEditAssistantOperator(item.assistant_operator ?? '')
    setEditCommissionMode(item.commission_basis ?? '')
    const points = toCommissionPoints(item.commission_rate)
    setEditCommissionRate(points?.toString() ?? '')
    setEditDialogOpen(true)
    setError(null)
  }

  const onEditSingle = async () => {
    if (!editingItem) {
      return
    }

    const normalizedName = editName.trim()
    if (!normalizedName) {
      setError('项目名称不能为空')
      return
    }

    setSubmitting(true)
    setError(null)
    setSuccessMessage(null)
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
          project_operator: editProjectOperator.trim() || null,
          assistant_operator: editAssistantOperator.trim() || null,
          commission_basis: editCommissionMode.trim() || null,
          commission_rate: isEditCashReceivedCommission ? null : (editCommissionRate ? parseFloat(editCommissionRate) : null),
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setEditDialogOpen(false)
      setEditingItem(null)
      setEditBrandName('')
      setEditStoreAddress('')
      setEditProjectOperator('')
      setEditAssistantOperator('')
      setEditCommissionMode('')
      setEditCommissionRate('')
      setSuccessMessage(`已更新项目名称：${normalizedName}`)
      await loadProjects()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '更新失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="outline" className="w-fit rounded-md">
                数据管理
              </Badge>
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
                <DialogContent>
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
                      <Select value={addProjectOperator} onValueChange={setAddProjectOperator} disabled={submitting}>
                        <SelectTrigger id="project-add-operator" className="flex-1">
                          <SelectValue placeholder="选择运营" />
                        </SelectTrigger>
                        <SelectContent>
                          {operatorOptions.length > 0 ? (
                            operatorOptions.map((name) => (
                              <SelectItem key={`operator-add-${name}`} value={name}>
                                {name}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="__empty_operator_add__" disabled>
                              暂无可选运营
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setAddProjectOperator('')}
                        disabled={submitting || !addProjectOperator}
                      >
                        清空
                      </Button>
                    </div>
                    <label htmlFor="project-add-assistant-operator" className="text-sm font-medium text-foreground">
                      助理运营
                    </label>
                    <div className="flex items-center gap-2">
                      <Select value={addAssistantOperator} onValueChange={setAddAssistantOperator} disabled={submitting}>
                        <SelectTrigger id="project-add-assistant-operator" className="flex-1">
                          <SelectValue placeholder="选择助理运营" />
                        </SelectTrigger>
                        <SelectContent>
                          {operatorOptions.length > 0 ? (
                            operatorOptions.map((name) => (
                              <SelectItem key={`assistant-operator-add-${name}`} value={name}>
                                {name}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="__empty_assistant_add__" disabled>
                              暂无可选助理运营
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setAddAssistantOperator('')}
                        disabled={submitting || !addAssistantOperator}
                      >
                        清空
                      </Button>
                    </div>
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
          </div>

          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          {successMessage ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              {successMessage}
            </div>
          ) : null}

          <div className="rounded-lg border border-border/70">
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto relative">
              <table className="w-full caption-bottom text-sm">
                <thead className="[&_tr]:border-b-0">
                  <tr className="border-b border-border/70 shadow-sm">
                    <th className="sticky top-0 z-20 h-12 w-[80px] bg-background px-4 text-left align-middle font-medium text-muted-foreground">ID</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">项目名称</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">品牌名称</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">运营</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">助理运营</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">佣金方式</th>
                    <th className="sticky top-0 z-20 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">佣金点数</th>
                    <th className="sticky top-0 z-20 h-12 w-[120px] bg-background px-4 text-left align-middle font-medium text-muted-foreground">店铺地址</th>
                    <th className="sticky top-0 z-20 h-12 w-[100px] bg-background px-4 text-right align-middle font-medium text-muted-foreground">操作</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                {loading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <tr key={`skeleton-${index}`} className="border-b transition-colors hover:bg-muted/50">
                      <td colSpan={10} className="p-4 align-middle">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : items.length === 0 ? (
                  <tr className="border-b transition-colors hover:bg-muted/50">
                    <td colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                      暂无项目数据，请先新增一个项目。
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 align-middle text-muted-foreground">{item.id}</td>
                      <td className="p-4 align-middle font-medium text-foreground">{item.name}</td>
                      <td className="p-4 align-middle">{item.brand_name || '-'}</td>
                      <td className="p-4 align-middle">{item.project_operator || '-'}</td>
                      <td className="p-4 align-middle">{item.assistant_operator || '-'}</td>
                      <td className="p-4 align-middle">{item.commission_basis ? COMMISSION_BASIS_LABEL[item.commission_basis] ?? item.commission_basis : '-'}</td>
                      <td className="p-4 align-middle">{item.commission_basis === 'cash_received' ? '阶梯(7/10/13/15%)' : (toCommissionPoints(item.commission_rate) ?? '-')}</td>
                      <td className="p-4 align-middle max-w-[120px] truncate" title={item.store_address || ''}>
                        {item.store_address ? `${item.store_address.slice(0, 15)}...` : '-'}
                      </td>
                      <td className="p-4 align-middle text-right">
                        <div className="flex justify-end">
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
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
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
              <Select value={editProjectOperator} onValueChange={setEditProjectOperator} disabled={submitting}>
                <SelectTrigger id="project-edit-operator" className="flex-1">
                  <SelectValue placeholder="选择运营" />
                </SelectTrigger>
                <SelectContent>
                  {operatorOptions.length > 0 ? (
                    operatorOptions.map((name) => (
                      <SelectItem key={`operator-edit-${name}`} value={name}>
                        {name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__empty_operator_edit__" disabled>
                      暂无可选运营
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditProjectOperator('')}
                disabled={submitting || !editProjectOperator}
              >
                清空
              </Button>
            </div>
            <label htmlFor="project-edit-assistant-operator" className="text-sm font-medium text-foreground">
              助理运营
            </label>
            <div className="flex items-center gap-2">
              <Select value={editAssistantOperator} onValueChange={setEditAssistantOperator} disabled={submitting}>
                <SelectTrigger id="project-edit-assistant-operator" className="flex-1">
                  <SelectValue placeholder="选择助理运营" />
                </SelectTrigger>
                <SelectContent>
                  {operatorOptions.length > 0 ? (
                    operatorOptions.map((name) => (
                      <SelectItem key={`assistant-operator-edit-${name}`} value={name}>
                        {name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__empty_assistant_edit__" disabled>
                      暂无可选助理运营
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditAssistantOperator('')}
                disabled={submitting || !editAssistantOperator}
              >
                清空
              </Button>
            </div>
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
    </div>
  )
}
