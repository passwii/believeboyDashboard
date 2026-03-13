'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Calculator, CheckCircle2, Loader2, Search, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'
const MAX_VISIBLE_RUNS = 8
const MAX_SELECTED_RUNS = 4

type PricingCalculationRunItem = {
  id: number
  product_name: string
  calculation_type: 'profit_calc' | 'profit_reverse'
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  size_tier: string
  size_tier_label: string
  price_band: string
  price_band_label: string
  usd_to_rmb_rate: number
  usd_to_rmb_rate_source: string
  fulfillment_fee_rule_label: string
  inbound_config_fee_rule_label: string
  storage_fee_rule_label: string
  dimensions: {
    longest_side_in: number
    middle_side_in: number
    shortest_side_in: number
    length_plus_girth_in: number
    volume_cubic_in: number
    volume_cubic_ft: number
  }
  weights: {
    product_weight_lb: number
    product_weight_oz: number
    dimensional_weight_lb: number
    chargeable_weight_lb: number
    chargeable_weight_oz: number
    chargeable_weight_rule: string
  }
  fees: {
    referral_fee_usd: number
    advertising_fee_usd: number
    return_loss_usd: number
    fba_fulfillment_fee_usd: number
    inbound_config_fee_usd: number
    storage_fee_usd: number
    total_fee_usd: number
  }
  profit: {
    ddp_cost_rmb: number
    ddp_cost_usd: number
    payout_usd: number
    profit_usd: number
    profit_rate: number
  }
  warnings: string[]
  created_by: string | null
  created_at: string
  updated_at: string
}

type ListResponse = {
  items: PricingCalculationRunItem[]
  total: number
  page: number
  page_size: number
}

type ProjectOption = {
  id: number | null
  name: string
}

type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  asin: string
  first_leg_unit_cost: number
  fob_unit_cost: number
  currency: string
  country: string
  sort_order: number
  is_active: boolean
}

type ProductCostsResponse = {
  items: ProductCostItem[]
  page: number
  page_size: number
  total?: number | null
  has_next: boolean
}

type FormState = {
  product_name: string
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  fob_product_cost_rmb: string
  first_leg_unit_price_rmb: string
  sale_price_usd: string
  target_profit_rate: string
  advertising_rate: string
  return_loss_rate: string
  storage_months: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type CalculationMode = 'profit-calc' | 'profit-reverse'
type BusinessTab = 'new-product' | 'store-accounting'

type StoreSkuDraft = {
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  first_leg_unit_price_rmb: string
  sale_price_usd: string
  advertising_rate: string
  return_loss_rate: string
  storage_months: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type StoreSkuRowState = {
  draft: StoreSkuDraft
  loading: boolean
  result: PricingCalculationRunItem | null
  error: string | null
}

const INITIAL_FORM: FormState = {
  product_name: '',
  package_length_cm: '',
  package_width_cm: '',
  package_height_cm: '',
  weight_kg: '',
  fob_product_cost_rmb: '',
  first_leg_unit_price_rmb: '6',
  sale_price_usd: '',
  target_profit_rate: '25',
  advertising_rate: '12',
  return_loss_rate: '4',
  storage_months: '1',
  inbound_placement_mode: 'single_destination',
  usd_to_rmb_rate: '',
}

function buildInitialStoreDraft(item: ProductCostItem): StoreSkuDraft {
  return {
    package_length_cm: '',
    package_width_cm: '',
    package_height_cm: '',
    weight_kg: '',
    first_leg_unit_price_rmb: item.first_leg_unit_cost > 0 ? String(item.first_leg_unit_cost) : '',
    sale_price_usd: '',
    advertising_rate: '12',
    return_loss_rate: '4',
    storage_months: '1',
    inbound_placement_mode: 'single_destination',
    usd_to_rmb_rate: '',
  }
}

function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`
}

function formatRmb(value: number) {
  return `RMB ${value.toFixed(2)}`
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

function formatMetric(value: number, digits = 4) {
  return value.toFixed(digits)
}

function toNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatCompactDate(value: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getCalculationTypeMeta(calculationType: PricingCalculationRunItem['calculation_type']) {
  if (calculationType === 'profit_reverse') {
    return {
      label: '利润倒算',
      badgeClassName: 'border-amber-300 bg-amber-100 text-amber-900',
      cardClassName: 'border-amber-300 bg-amber-50/80 hover:border-amber-400 hover:bg-amber-50',
      selectedClassName: 'border-amber-400 bg-amber-100 shadow-sm ring-1 ring-amber-200',
    }
  }

  return {
    label: '利润核算',
    badgeClassName: 'border-sky-300 bg-sky-100 text-sky-900',
    cardClassName: 'border-sky-200 bg-sky-50/70 hover:border-sky-300 hover:bg-sky-50',
    selectedClassName: 'border-sky-400 bg-sky-100 shadow-sm ring-1 ring-sky-200',
  }
}

export default function PricingCalculationPage() {
  const [activeBusinessTab, setActiveBusinessTab] = useState<BusinessTab>('new-product')
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [calculationMode, setCalculationMode] = useState<CalculationMode>('profit-calc')
  const [runs, setRuns] = useState<PricingCalculationRunItem[]>([])
  const [productKeyword, setProductKeyword] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [skuKeyword, setSkuKeyword] = useState('')
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [storeSkusLoading, setStoreSkusLoading] = useState(false)
  const [storeSkusError, setStoreSkusError] = useState<string | null>(null)
  const [storeRows, setStoreRows] = useState<Record<number, StoreSkuRowState>>({})

  useEffect(() => {
    async function loadRuns() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/runs?page=1&page_size=24`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as ListResponse | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || '测算记录加载失败')
        }
        setRuns((payload as ListResponse).items)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '测算记录加载失败')
      }
    }

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as ProjectOption[] | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || '项目列表加载失败')
        }
        setProjects(payload as ProjectOption[])
      } catch (loadError) {
        setProjectsError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }

    void loadRuns()
    void loadProjects()
  }, [])

  useEffect(() => {
    async function loadProjectSkus() {
      if (!selectedProjectName) {
        setStoreSkus([])
        setStoreSkusError(null)
        setStoreRows({})
        return
      }

      setStoreSkusLoading(true)
      setStoreSkusError(null)
      try {
        const search = new URLSearchParams({
          project_name: selectedProjectName,
          is_active: 'true',
          page: '1',
          page_size: '200',
          include_total: 'true',
        })
        const response = await fetch(`${API_BASE}/api/v1/product-costs?${search.toString()}`, {
          cache: 'no-store',
        })
        const payload = (await response.json()) as ProductCostsResponse | { detail?: string; message?: string }
        if (!response.ok) {
          const errorPayload = payload as { detail?: string; message?: string }
          throw new Error(errorPayload.detail || errorPayload.message || 'SKU 列表加载失败')
        }

        const items = (payload as ProductCostsResponse).items
        setStoreSkus(items)
        setStoreRows((current) => {
          const next: Record<number, StoreSkuRowState> = {}
          items.forEach((item) => {
            const existing = current[item.id]
            next[item.id] = {
              draft: existing?.draft ?? buildInitialStoreDraft(item),
              loading: false,
              result: existing?.result ?? null,
              error: existing?.error ?? null,
            }
          })
          return next
        })
      } catch (loadError) {
        setStoreSkus([])
        setStoreRows({})
        setStoreSkusError(loadError instanceof Error ? loadError.message : 'SKU 列表加载失败')
      } finally {
        setStoreSkusLoading(false)
      }
    }

    void loadProjectSkus()
  }, [selectedProjectName])

  const filteredRuns = useMemo(() => {
    const normalizedKeyword = productKeyword.trim().toLowerCase()
    if (!normalizedKeyword) {
      return runs
    }
    return runs.filter((run) => run.product_name.toLowerCase().includes(normalizedKeyword))
  }, [productKeyword, runs])
  const visibleRuns = useMemo(() => filteredRuns.slice(0, MAX_VISIBLE_RUNS), [filteredRuns])
  const selectedRuns = useMemo(() => {
    if (selectedRunIds.length === 0) {
      return []
    }
    const selectedSet = new Set(selectedRunIds)
    return runs.filter((run) => selectedSet.has(run.id)).slice(0, MAX_SELECTED_RUNS)
  }, [runs, selectedRunIds])
  const volumeWeightKg = useMemo(() => {
    return (toNumber(form.package_length_cm) * toNumber(form.package_width_cm) * toNumber(form.package_height_cm)) / 6000
  }, [form.package_height_cm, form.package_length_cm, form.package_width_cm])
  const chargeableWeightKg = useMemo(() => {
    return Math.max(toNumber(form.weight_kg), volumeWeightKg)
  }, [form.weight_kg, volumeWeightKg])
  const firstLegCostRmb = useMemo(() => {
    return chargeableWeightKg * toNumber(form.first_leg_unit_price_rmb)
  }, [chargeableWeightKg, form.first_leg_unit_price_rmb])
  const filteredStoreSkus = useMemo(() => {
    const normalizedKeyword = skuKeyword.trim().toLowerCase()
    if (!normalizedKeyword) {
      return storeSkus
    }
    return storeSkus.filter((item) => {
      return [item.sku, item.asin, item.project_name].some((value) => value.toLowerCase().includes(normalizedKeyword))
    })
  }, [skuKeyword, storeSkus])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const createdRun = await requestPricingCalculation({
        calculationMode,
        product_name: form.product_name.trim(),
        package_length_cm: Number(form.package_length_cm),
        package_width_cm: Number(form.package_width_cm),
        package_height_cm: Number(form.package_height_cm),
        weight_kg: Number(form.weight_kg),
        fob_product_cost_rmb: Number(form.fob_product_cost_rmb),
        first_leg_cost_rmb: firstLegCostRmb,
        sale_price_usd: Number(form.sale_price_usd),
        target_profit_rate: Number(form.target_profit_rate) / 100,
        advertising_rate: Number(form.advertising_rate) / 100,
        return_loss_rate: Number(form.return_loss_rate) / 100,
        storage_months: Number(form.storage_months),
        inbound_placement_mode: form.inbound_placement_mode,
        usd_to_rmb_rate: form.usd_to_rmb_rate.trim() ? Number(form.usd_to_rmb_rate) : undefined,
      })

      setRuns((current) => [createdRun, ...current])
      setSelectedRunIds((current) => [createdRun.id, ...current.filter((id) => id !== createdRun.id)].slice(0, MAX_SELECTED_RUNS))
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '定价测算失败')
    } finally {
      setLoading(false)
    }
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function toggleRunSelection(runId: number) {
    setSelectedRunIds((current) => {
      if (current.includes(runId)) {
        return current.filter((id) => id !== runId)
      }
      return [runId, ...current].slice(0, MAX_SELECTED_RUNS)
    })
  }

  async function handleDeleteRun(runId: number) {
    const confirmed = window.confirm('确认删除这条测算记录吗？删除后不可恢复。')
    if (!confirmed) {
      return
    }

    setDeletingRunId(runId)
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/pricing-calculation/runs/${runId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
        throw new Error(payload?.detail || payload?.message || '删除测算记录失败')
      }

      setRuns((current) => current.filter((run) => run.id !== runId))
      setSelectedRunIds((current) => current.filter((id) => id !== runId))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除测算记录失败')
    } finally {
      setDeletingRunId(null)
    }
  }

  function updateStoreDraft(rowId: number, key: keyof StoreSkuDraft, value: string) {
    setStoreRows((current) => {
      const row = current[rowId]
      if (!row) return current
      return {
        ...current,
        [rowId]: {
          ...row,
          draft: {
            ...row.draft,
            [key]: value,
          },
        },
      }
    })
  }

  async function handleStoreSkuCalculate(item: ProductCostItem) {
    const rowState = storeRows[item.id]
    if (!rowState) return

    setStoreRows((current) => ({
      ...current,
      [item.id]: {
        ...current[item.id],
        loading: true,
        error: null,
      },
    }))

    try {
      const draft = rowState.draft
      const packageLength = Number(draft.package_length_cm)
      const packageWidth = Number(draft.package_width_cm)
      const packageHeight = Number(draft.package_height_cm)
      const weightKg = Number(draft.weight_kg)
      const unitPrice = Number(draft.first_leg_unit_price_rmb)
      const volumeKg = (packageLength * packageWidth * packageHeight) / 6000
      const chargeableKg = Math.max(weightKg, volumeKg)
      const createdRun = await requestPricingCalculation({
        calculationMode: 'profit-calc',
        product_name: `${item.project_name} / ${item.sku}`,
        package_length_cm: packageLength,
        package_width_cm: packageWidth,
        package_height_cm: packageHeight,
        weight_kg: weightKg,
        fob_product_cost_rmb: item.fob_unit_cost,
        first_leg_cost_rmb: chargeableKg * unitPrice,
        sale_price_usd: Number(draft.sale_price_usd),
        target_profit_rate: 0,
        advertising_rate: Number(draft.advertising_rate) / 100,
        return_loss_rate: Number(draft.return_loss_rate) / 100,
        storage_months: Number(draft.storage_months),
        inbound_placement_mode: draft.inbound_placement_mode,
        usd_to_rmb_rate: draft.usd_to_rmb_rate.trim() ? Number(draft.usd_to_rmb_rate) : undefined,
      })

      setStoreRows((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          loading: false,
          result: createdRun,
          error: null,
        },
      }))
      setRuns((current) => [createdRun, ...current])
    } catch (submitError) {
      setStoreRows((current) => ({
        ...current,
        [item.id]: {
          ...current[item.id],
          loading: false,
          error: submitError instanceof Error ? submitError.message : '店铺核算失败',
        },
      }))
    }
  }

  return (
    <div className="space-y-4">
      <Tabs value={activeBusinessTab} onValueChange={(value) => setActiveBusinessTab(value as BusinessTab)} className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">定价测算</h1>
            <p className="text-sm text-slate-500">在同一个工作台里完成新品核算与店铺维度 SKU 测算。</p>
          </div>
          <TabsList className="grid w-full grid-cols-2 lg:w-[320px]">
            <TabsTrigger value="new-product">新品核算</TabsTrigger>
            <TabsTrigger value="store-accounting">店铺核算</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="new-product" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[520px_minmax(0,1fr)]">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">测算输入</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleSubmit}>
                  <Tabs value={calculationMode} onValueChange={(value) => setCalculationMode(value as CalculationMode)}>
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="profit-calc">利润核算</TabsTrigger>
                      <TabsTrigger value="profit-reverse">利润倒算</TabsTrigger>
                    </TabsList>
                  </Tabs>

                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                    <Field label="产品名称">
                      <Input value={form.product_name} onChange={(event) => updateField('product_name', event.target.value)} placeholder="例如：桌面置物架" required />
                    </Field>
                    <Field label="FOB 产品成本(RMB)">
                      <Input type="number" step="0.01" value={form.fob_product_cost_rmb} onChange={(event) => updateField('fob_product_cost_rmb', event.target.value)} required />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="长(cm)">
                      <Input type="number" step="0.01" value={form.package_length_cm} onChange={(event) => updateField('package_length_cm', event.target.value)} required />
                    </Field>
                    <Field label="宽(cm)">
                      <Input type="number" step="0.01" value={form.package_width_cm} onChange={(event) => updateField('package_width_cm', event.target.value)} required />
                    </Field>
                    <Field label="高(cm)">
                      <Input type="number" step="0.01" value={form.package_height_cm} onChange={(event) => updateField('package_height_cm', event.target.value)} required />
                    </Field>
                    <Field label="重量(kg)">
                      <Input type="number" step="0.001" value={form.weight_kg} onChange={(event) => updateField('weight_kg', event.target.value)} required />
                    </Field>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                      <div className="space-y-3">
                        <Field label="头程单价(RMB/kg)">
                          <Input type="number" step="0.01" value={form.first_leg_unit_price_rmb} onChange={(event) => updateField('first_leg_unit_price_rmb', event.target.value)} required />
                        </Field>
                        <p className="text-xs leading-5 text-slate-500">
                          实重 {formatMetric(toNumber(form.weight_kg), 3)} kg，体积重 {formatMetric(volumeWeightKg, 3)} kg，计费重取较大值。
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-xs text-slate-500">头程成本(RMB)</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-900">{firstLegCostRmb.toFixed(2)}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatMetric(chargeableWeightKg, 3)} kg × {toNumber(form.first_leg_unit_price_rmb).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {calculationMode === 'profit-calc' ? (
                      <Field label="售价(USD)">
                        <Input type="number" step="0.01" value={form.sale_price_usd} onChange={(event) => updateField('sale_price_usd', event.target.value)} required />
                      </Field>
                    ) : (
                      <Field label="目标利润率(%)">
                        <Input type="number" step="0.01" value={form.target_profit_rate} onChange={(event) => updateField('target_profit_rate', event.target.value)} required />
                      </Field>
                    )}
                    <Field label="广告费率(%)">
                      <Input type="number" step="0.01" value={form.advertising_rate} onChange={(event) => updateField('advertising_rate', event.target.value)} required />
                    </Field>
                    <Field label="退货折损率(%)">
                      <Input type="number" step="0.01" value={form.return_loss_rate} onChange={(event) => updateField('return_loss_rate', event.target.value)} required />
                    </Field>
                    <Field label="仓储月数">
                      <Input type="number" step="0.01" value={form.storage_months} onChange={(event) => updateField('storage_months', event.target.value)} required />
                    </Field>
                  </div>

                  <Button type="submit" disabled={loading} className="h-10 w-full">
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                    {calculationMode === 'profit-reverse' ? '倒算售价' : '开始测算'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">筛选产品</CardTitle>
                  <CardDescription>先搜索产品，再选择最多 {MAX_SELECTED_RUNS} 个测算结果进入对比矩阵。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-3 md:flex-row">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        value={productKeyword}
                        onChange={(event) => setProductKeyword(event.target.value)}
                        placeholder="按产品名称筛选"
                        className="pl-9"
                      />
                    </div>
                    <Button type="button" variant="outline" onClick={() => setSelectedRunIds([])} disabled={selectedRunIds.length === 0}>
                      清空选择
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>筛选结果 {filteredRuns.length} 条</span>
                    <span>已选 {selectedRuns.length}/{MAX_SELECTED_RUNS}</span>
                    {productKeyword ? <span>关键词: {productKeyword}</span> : null}
                  </div>
                </CardContent>
              </Card>

              {error ? (
                <Card className="border-destructive/40">
                  <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </CardContent>
                </Card>
              ) : null}

              <Card className="border-slate-200 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">最近测算</CardTitle>
                  <CardDescription>点击卡片即可加入或移出对比矩阵。</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-3">
                    {visibleRuns.length === 0 ? (
                      <div className="rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                        {runs.length === 0 ? '暂无测算记录' : '没有匹配当前筛选条件的产品'}
                      </div>
                    ) : (
                      visibleRuns.map((run) => {
                        const typeMeta = getCalculationTypeMeta(run.calculation_type ?? 'profit_calc')
                        const isSelected = selectedRunIds.includes(run.id)

                        return (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => toggleRunSelection(run.id)}
                            className={cn(
                              'min-w-[180px] rounded-xl border p-3 text-left transition-colors',
                              isSelected ? typeMeta.selectedClassName : typeMeta.cardClassName
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-xs text-slate-500">{formatCompactDate(run.created_at)}</p>
                                <p className="mt-1 line-clamp-1 text-sm font-semibold text-slate-900">{run.product_name}</p>
                              </div>
                              <div className="flex items-center gap-1">
                                {isSelected ? (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                ) : (
                                  <X className="h-4 w-4 text-slate-300" />
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-full text-slate-400 hover:bg-white/70 hover:text-rose-600"
                                  disabled={deletingRunId === run.id}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleDeleteRun(run.id)
                                  }}
                                >
                                  {deletingRunId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                </Button>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <Badge className={cn('border text-[10px]', typeMeta.badgeClassName)}>{typeMeta.label}</Badge>
                              <Badge variant="secondary" className="text-[10px]">{run.size_tier_label}</Badge>
                            </div>
                            <p className={`mt-2 text-lg font-semibold ${run.profit.profit_usd >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {formatCurrency(run.profit.profit_usd)}
                            </p>
                            <p className="text-xs text-slate-500">{formatPercent(run.profit.profit_rate)}</p>
                          </button>
                        )
                      })
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">测算对比矩阵</CardTitle>
              <CardDescription>只展示当前已选中的产品，方便横向比较成本、费用与利润。</CardDescription>
            </CardHeader>
            <CardContent>
              <ComparisonTable runs={selectedRuns} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="store-accounting" className="space-y-4">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">项目筛选</CardTitle>
              <CardDescription>先选择项目，再按 SKU 逐行填写测算参数并生成结果。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)_140px]">
                <Field label="项目">
                  <select
                    value={selectedProjectName}
                    onChange={(event) => setSelectedProjectName(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                  >
                    <option value="">请选择项目</option>
                    {projects.map((project) => (
                      <option key={`${project.id ?? project.name}-${project.name}`} value={project.name}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="SKU / ASIN 搜索">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input value={skuKeyword} onChange={(event) => setSkuKeyword(event.target.value)} placeholder="输入 SKU、ASIN 或项目名" className="pl-9" />
                  </div>
                </Field>
                <div className="flex items-end">
                  <div className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {projectsLoading ? '项目加载中...' : `SKU 数量 ${filteredStoreSkus.length}`}
                  </div>
                </div>
              </div>

              {projectsError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{projectsError}</div>
              ) : null}
              {storeSkusError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{storeSkusError}</div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">店铺 SKU 核算表</CardTitle>
              <CardDescription>每行一个 SKU，FOB 取 SKU 成本档案，尺寸、重量、售价等参数由用户手动填写后逐行测算。</CardDescription>
            </CardHeader>
            <CardContent>
              {!selectedProjectName ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">请选择项目后查看对应 SKU。</div>
              ) : storeSkusLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在加载 SKU 列表...
                </div>
              ) : filteredStoreSkus.length === 0 ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">当前项目下暂无匹配的 SKU。</div>
              ) : (
                <StoreAccountingTable items={filteredStoreSkus} rowStates={storeRows} onDraftChange={updateStoreDraft} onCalculate={handleStoreSkuCalculate} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

async function requestPricingCalculation(payload: {
  calculationMode: CalculationMode
  product_name: string
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  fob_product_cost_rmb: number
  first_leg_cost_rmb: number
  sale_price_usd: number
  target_profit_rate: number
  advertising_rate: number
  return_loss_rate: number
  storage_months: number
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate?: number
}): Promise<PricingCalculationRunItem> {
  const endpoint =
    payload.calculationMode === 'profit-reverse'
      ? `${API_BASE}/api/v1/pricing-calculation/reverse-quote`
      : `${API_BASE}/api/v1/pricing-calculation/quote`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_name: payload.product_name,
      package_length_cm: payload.package_length_cm,
      package_width_cm: payload.package_width_cm,
      package_height_cm: payload.package_height_cm,
      weight_kg: payload.weight_kg,
      fob_product_cost_rmb: payload.fob_product_cost_rmb,
      first_leg_cost_rmb: payload.first_leg_cost_rmb,
      ...(payload.calculationMode === 'profit-reverse'
        ? { target_profit_rate: payload.target_profit_rate }
        : { sale_price_usd: payload.sale_price_usd }),
      advertising_rate: payload.advertising_rate,
      return_loss_rate: payload.return_loss_rate,
      storage_months: payload.storage_months,
      inbound_placement_mode: payload.inbound_placement_mode,
      ...(payload.usd_to_rmb_rate ? { usd_to_rmb_rate: payload.usd_to_rmb_rate } : {}),
    }),
  })

  const body = (await response.json()) as PricingCalculationRunItem | { detail?: string; message?: string }
  if (!response.ok) {
    const errorPayload = body as { detail?: string; message?: string }
    throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
  }
  return body as PricingCalculationRunItem
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function StoreAccountingTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
}: {
  items: ProductCostItem[]
  rowStates: Record<number, StoreSkuRowState>
  onDraftChange: (rowId: number, key: keyof StoreSkuDraft, value: string) => void
  onCalculate: (item: ProductCostItem) => void
}) {
  return (
    <Table className="text-xs" containerClassName="rounded-xl border">
      <TableHeader className="bg-slate-50">
        <TableRow>
          <TableHead className="min-w-[180px]">SKU 信息</TableHead>
          <TableHead className="min-w-[380px]">手动填写参数</TableHead>
          <TableHead className="min-w-[240px]">费用与利润</TableHead>
          <TableHead className="min-w-[220px]">规则信息</TableHead>
          <TableHead className="min-w-[120px] text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const rowState = rowStates[item.id]
          const draft = rowState?.draft ?? buildInitialStoreDraft(item)
          const volumeKg = (toNumber(draft.package_length_cm) * toNumber(draft.package_width_cm) * toNumber(draft.package_height_cm)) / 6000
          const chargeableKg = Math.max(toNumber(draft.weight_kg), volumeKg)
          const firstLegCost = chargeableKg * toNumber(draft.first_leg_unit_price_rmb)
          const result = rowState?.result

          return (
            <TableRow key={item.id} className="align-top">
              <TableCell>
                <div className="space-y-2">
                  <div>
                    <p className="font-semibold text-slate-900">{item.sku}</p>
                    <p className="text-slate-500">{item.project_name}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">ASIN {item.asin}</Badge>
                    <Badge variant="outline">{item.country}</Badge>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-600">
                    <p>FOB: {formatRmb(item.fob_unit_cost)}</p>
                    <p>头程单价: {draft.first_leg_unit_price_rmb || '未填'} RMB/kg</p>
                    <p>头程成本: {firstLegCost > 0 ? formatRmb(firstLegCost) : '-'}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="grid gap-2 md:grid-cols-4">
                  <MiniField label="长(cm)">
                    <Input type="number" step="0.01" value={draft.package_length_cm} onChange={(event) => onDraftChange(item.id, 'package_length_cm', event.target.value)} />
                  </MiniField>
                  <MiniField label="宽(cm)">
                    <Input type="number" step="0.01" value={draft.package_width_cm} onChange={(event) => onDraftChange(item.id, 'package_width_cm', event.target.value)} />
                  </MiniField>
                  <MiniField label="高(cm)">
                    <Input type="number" step="0.01" value={draft.package_height_cm} onChange={(event) => onDraftChange(item.id, 'package_height_cm', event.target.value)} />
                  </MiniField>
                  <MiniField label="重量(kg)">
                    <Input type="number" step="0.001" value={draft.weight_kg} onChange={(event) => onDraftChange(item.id, 'weight_kg', event.target.value)} />
                  </MiniField>
                  <MiniField label="头程单价">
                    <Input type="number" step="0.01" value={draft.first_leg_unit_price_rmb} onChange={(event) => onDraftChange(item.id, 'first_leg_unit_price_rmb', event.target.value)} />
                  </MiniField>
                  <MiniField label="售价(USD)">
                    <Input type="number" step="0.01" value={draft.sale_price_usd} onChange={(event) => onDraftChange(item.id, 'sale_price_usd', event.target.value)} />
                  </MiniField>
                  <MiniField label="广告费率(%)">
                    <Input type="number" step="0.01" value={draft.advertising_rate} onChange={(event) => onDraftChange(item.id, 'advertising_rate', event.target.value)} />
                  </MiniField>
                  <MiniField label="退货折损率(%)">
                    <Input type="number" step="0.01" value={draft.return_loss_rate} onChange={(event) => onDraftChange(item.id, 'return_loss_rate', event.target.value)} />
                  </MiniField>
                  <MiniField label="仓储月数">
                    <Input type="number" step="0.01" value={draft.storage_months} onChange={(event) => onDraftChange(item.id, 'storage_months', event.target.value)} />
                  </MiniField>
                  <MiniField label="汇率(可选)">
                    <Input type="number" step="0.0001" value={draft.usd_to_rmb_rate} onChange={(event) => onDraftChange(item.id, 'usd_to_rmb_rate', event.target.value)} />
                  </MiniField>
                  <MiniField label="入库模式">
                    <select
                      value={draft.inbound_placement_mode}
                      onChange={(event) => onDraftChange(item.id, 'inbound_placement_mode', event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                    >
                      <option value="single_destination">单仓</option>
                      <option value="amazon_optimized_split">亚马逊优化拆仓</option>
                    </select>
                  </MiniField>
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3 text-slate-500 md:col-span-1">
                    <p>体积重 {formatMetric(volumeKg, 3)} kg</p>
                    <p>计费重 {formatMetric(chargeableKg, 3)} kg</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {result ? (
                  <div className="space-y-2">
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                      <p className={`text-lg font-semibold ${result.profit.profit_usd >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                        {formatCurrency(result.profit.profit_usd)}
                      </p>
                      <p className="text-slate-600">利润率 {formatPercent(result.profit.profit_rate)}</p>
                    </div>
                    <div className="space-y-1 text-slate-700">
                      <p>售价 {formatCurrency(result.sale_price_usd)}</p>
                      <p>DDP {formatCurrency(result.profit.ddp_cost_usd)} / {formatRmb(result.profit.ddp_cost_rmb)}</p>
                      <p>总费用 {formatCurrency(result.fees.total_fee_usd)}</p>
                      <p>FBA 派送 {formatCurrency(result.fees.fba_fulfillment_fee_usd)}</p>
                      <p>广告 {formatCurrency(result.fees.advertising_fee_usd)}</p>
                    </div>
                    {result.warnings.length > 0 ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
                        {result.warnings.join('；')}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed px-3 py-8 text-center text-muted-foreground">填写参数后点击测算</div>
                )}
                {rowState?.error ? <div className="mt-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-destructive">{rowState.error}</div> : null}
              </TableCell>
              <TableCell>
                {result ? (
                  <div className="space-y-1 text-slate-700">
                    <p>尺寸等级: {result.size_tier_label}</p>
                    <p>售价带: {result.price_band_label}</p>
                    <p>计费重: {formatMetric(result.weights.chargeable_weight_lb, 3)} lb</p>
                    <p>派送规则: {result.fulfillment_fee_rule_label}</p>
                    <p>配置费规则: {result.inbound_config_fee_rule_label}</p>
                    <p>仓储规则: {result.storage_fee_rule_label}</p>
                  </div>
                ) : (
                  <div className="text-slate-400">暂无结果</div>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button type="button" onClick={() => onCalculate(item)} disabled={rowState?.loading} className="min-w-[88px]">
                  {rowState?.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                  测算
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-500">{label}</Label>
      {children}
    </div>
  )
}

function ComparisonTable({ runs }: { runs: PricingCalculationRunItem[] }) {
  if (runs.length === 0) {
    return <div className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无可对比的测算结果</div>
  }

  const sections: Array<{ title: string; rows: Array<{ label: string; getValue: (run: PricingCalculationRunItem) => string }> }> = [
    {
      title: '货品数据',
      rows: [
        { label: '产品名称', getValue: (run) => run.product_name },
        { label: '包装尺寸(cm)', getValue: (run) => `${run.package_length_cm} × ${run.package_width_cm} × ${run.package_height_cm}` },
        { label: '重量(kg)', getValue: (run) => formatMetric(run.weight_kg, 3) },
      ],
    },
    {
      title: 'DDP 成本',
      rows: [
        { label: 'FOB成本', getValue: (run) => formatRmb(run.fob_product_cost_rmb) },
        { label: '头程', getValue: (run) => formatRmb(run.first_leg_cost_rmb) },
        { label: 'DDP(RMB)', getValue: (run) => formatRmb(run.profit.ddp_cost_rmb) },
        { label: 'DDP(USD)', getValue: (run) => formatCurrency(run.profit.ddp_cost_usd) },
      ],
    },
    {
      title: '费用支出',
      rows: [
        { label: '佣金', getValue: (run) => formatCurrency(run.fees.referral_fee_usd) },
        { label: '广告', getValue: (run) => `${formatCurrency(run.fees.advertising_fee_usd)} / ${formatPercent(run.advertising_rate)}` },
        { label: '派送', getValue: (run) => formatCurrency(run.fees.fba_fulfillment_fee_usd) },
        { label: '配置费', getValue: (run) => formatCurrency(run.fees.inbound_config_fee_usd) },
        { label: '仓储', getValue: (run) => `${formatCurrency(run.fees.storage_fee_usd)} / ${run.storage_months}月` },
        { label: '退货', getValue: (run) => `${formatCurrency(run.fees.return_loss_usd)} / ${formatPercent(run.return_loss_rate)}` },
        { label: '合计', getValue: (run) => formatCurrency(run.fees.total_fee_usd) },
      ],
    },
    {
      title: '售价与利润',
      rows: [
        { label: '售价', getValue: (run) => formatCurrency(run.sale_price_usd) },
        { label: '回款', getValue: (run) => formatCurrency(run.profit.payout_usd) },
        { label: '利润', getValue: (run) => formatCurrency(run.profit.profit_usd) },
        { label: '利润率', getValue: (run) => formatPercent(run.profit.profit_rate) },
      ],
    },
    {
      title: '规则',
      rows: [
        { label: '计费重', getValue: (run) => formatMetric(run.weights.chargeable_weight_lb) + ' lb' },
        { label: '体积', getValue: (run) => formatMetric(run.dimensions.volume_cubic_ft, 2) + ' ft³' },
        { label: '派送规则', getValue: (run) => run.fulfillment_fee_rule_label },
        { label: '入库配置', getValue: (run) => run.inbound_config_fee_rule_label },
        { label: '仓储规则', getValue: (run) => run.storage_fee_rule_label },
      ],
    },
  ]

  const sectionStyles: Record<string, { categoryCell: string; subCell: string }> = {
    '货品数据': {
      categoryCell: 'bg-sky-100 text-sky-950 border-sky-200',
      subCell: 'bg-sky-50/70',
    },
    'DDP 成本': {
      categoryCell: 'bg-amber-100 text-amber-950 border-amber-200',
      subCell: 'bg-amber-50/70',
    },
    '费用支出': {
      categoryCell: 'bg-rose-100 text-rose-950 border-rose-200',
      subCell: 'bg-rose-50/70',
    },
    '售价与利润': {
      categoryCell: 'bg-emerald-100 text-emerald-950 border-emerald-200',
      subCell: 'bg-emerald-50/70',
    },
    '规则': {
      categoryCell: 'bg-violet-100 text-violet-950 border-violet-200',
      subCell: 'bg-violet-50/70',
    },
  }

  return (
    <Table className="text-xs" containerClassName="rounded-xl border">
      <TableHeader className="bg-slate-50">
        <TableRow>
          <TableHead className="sticky left-0 z-20 min-w-[120px] bg-slate-50">指标</TableHead>
          <TableHead className="sticky left-[120px] z-20 min-w-[160px] border-l bg-slate-50">小类</TableHead>
          {runs.map((run) => (
            <TableHead key={run.id} className="min-w-[180px] border-l align-top">
              <div className="space-y-1 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">{run.product_name}</span>
                  <Badge variant="outline" className="text-[10px]">#{run.id}</Badge>
                </div>
                <div className="text-[10px] text-slate-500">{formatCompactDate(run.created_at)}</div>
              </div>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sections.flatMap((section) =>
          section.rows.map((row, index) => (
            <TableRow key={`${section.title}-${row.label}`}>
              {index === 0 ? (
                <TableCell
                  rowSpan={section.rows.length}
                  className={cn(
                    'sticky left-0 z-10 min-w-[120px] border-r align-top font-semibold shadow-[inset_-1px_0_0_rgba(255,255,255,0.35)]',
                    sectionStyles[section.title]?.categoryCell ?? 'bg-slate-100 text-slate-900 border-slate-200'
                  )}
                >
                  {section.title}
                </TableCell>
              ) : null}
              <TableCell
                className={cn(
                  'sticky left-[120px] z-10 min-w-[160px] border-l font-medium text-slate-700',
                  sectionStyles[section.title]?.subCell ?? 'bg-background'
                )}
              >
                {row.label}
              </TableCell>
              {runs.map((run) => (
                <TableCell key={`${row.label}-${run.id}`} className="border-l align-top leading-5 text-slate-900">
                  {row.getValue(run)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
