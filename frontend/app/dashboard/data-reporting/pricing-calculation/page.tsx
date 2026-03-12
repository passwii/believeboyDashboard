'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Calculator, CheckCircle2, Database, Loader2, Package2, Search, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'
const MAX_VISIBLE_RUNS = 8
const MAX_SELECTED_RUNS = 4

type PricingCalculationRunItem = {
  id: number
  product_name: string
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

const INITIAL_FORM: FormState = {
  product_name: '',
  package_length_cm: '40',
  package_width_cm: '30',
  package_height_cm: '10',
  weight_kg: '0.5',
  fob_product_cost_rmb: '32',
  first_leg_unit_price_rmb: '6',
  sale_price_usd: '30',
  target_profit_rate: '25',
  advertising_rate: '12',
  return_loss_rate: '4',
  storage_months: '1',
  inbound_placement_mode: 'single_destination',
  usd_to_rmb_rate: '',
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

export default function PricingCalculationPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [calculationMode, setCalculationMode] = useState<CalculationMode>('profit-calc')
  const [runs, setRuns] = useState<PricingCalculationRunItem[]>([])
  const [productKeyword, setProductKeyword] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      } finally {
        setBootstrapping(false)
      }
    }

    void loadRuns()
  }, [])

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const endpoint =
        calculationMode === 'profit-reverse'
          ? `${API_BASE}/api/v1/pricing-calculation/reverse-quote`
          : `${API_BASE}/api/v1/pricing-calculation/quote`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_name: form.product_name.trim(),
          package_length_cm: Number(form.package_length_cm),
          package_width_cm: Number(form.package_width_cm),
          package_height_cm: Number(form.package_height_cm),
          weight_kg: Number(form.weight_kg),
          fob_product_cost_rmb: Number(form.fob_product_cost_rmb),
          first_leg_cost_rmb: firstLegCostRmb,
          ...(calculationMode === 'profit-reverse'
            ? { target_profit_rate: Number(form.target_profit_rate) / 100 }
            : { sale_price_usd: Number(form.sale_price_usd) }),
          advertising_rate: Number(form.advertising_rate) / 100,
          return_loss_rate: Number(form.return_loss_rate) / 100,
          storage_months: Number(form.storage_months),
          inbound_placement_mode: form.inbound_placement_mode,
          ...(form.usd_to_rmb_rate.trim() ? { usd_to_rmb_rate: Number(form.usd_to_rmb_rate) } : {}),
        }),
      })

      const payload = (await response.json()) as PricingCalculationRunItem | { detail?: string; message?: string }
      if (!response.ok) {
        const errorPayload = payload as { detail?: string; message?: string }
        throw new Error(errorPayload.detail || errorPayload.message || '定价测算失败')
      }

      const createdRun = payload as PricingCalculationRunItem
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

  return (
    <div className="space-y-4">
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
          <div className="grid gap-3 md:grid-cols-2">
            <SummaryCard icon={<Database className="h-4 w-4" />} label="历史" value={bootstrapping ? '...' : String(runs.length)} />
            <SummaryCard icon={<Package2 className="h-4 w-4" />} label="已选对比" value={`${selectedRuns.length}/${MAX_SELECTED_RUNS}`} />
          </div>

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
                  visibleRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => toggleRunSelection(run.id)}
                      className={cn(
                        'min-w-[180px] rounded-xl border p-3 text-left transition-colors',
                        selectedRunIds.includes(run.id)
                          ? 'border-emerald-300 bg-emerald-50 shadow-sm'
                          : 'bg-slate-50/80 hover:border-slate-300 hover:bg-white'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs text-slate-500">{formatCompactDate(run.created_at)}</p>
                          <p className="mt-1 line-clamp-1 text-sm font-semibold text-slate-900">{run.product_name}</p>
                        </div>
                        {selectedRunIds.includes(run.id) ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <X className="h-4 w-4 text-slate-300" />
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">{run.size_tier_label}</Badge>
                      </div>
                      <p className={`mt-2 text-lg font-semibold ${run.profit.profit_usd >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {formatCurrency(run.profit.profit_usd)}
                      </p>
                      <p className="text-xs text-slate-500">{formatPercent(run.profit.profit_rate)}</p>
                    </button>
                  ))
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
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-xl font-semibold text-slate-900">{value}</p>
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
