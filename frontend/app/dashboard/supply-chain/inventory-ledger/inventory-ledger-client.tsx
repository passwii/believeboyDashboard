'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock4,
  RefreshCw,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
  DENSE_CELL,
  DENSE_HEAD,
} from '@/components/ui/data-card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { cn } from '@/lib/utils'
import { fetchLedgerJson } from './ledger-load'

const API_BASE = '/api/backend/api/v1'

// ── Types ────────────────────────────────────────────────────────────────────

type ProjectOption = { id: number; name: string }

type SkuMonthEom = {
  msku: string
  title: string | null
  qty_eom: number
  sellable_qty: number
  damaged_qty: number
  prev_qty_eom: number | null
  change: number | null
}

type DispositionSummary = {
  disposition: string
  qty_eom: number
  pct_of_total: number
}

type IntegrityMismatch = {
  msku: string
  location: string
  disposition: string
  prev_ending: number
  curr_starting: number
  diff: number
}

type IntegrityCheck = {
  report_month: string
  status: 'OK' | 'MISMATCH' | 'PENDING'
  mismatch_count: number
  mismatches: IntegrityMismatch[]
  checked_at: string
}

type SnapshotResponse = {
  report_month: string
  sku_count: number
  total_qty: number
  disposition_summary: DispositionSummary[]
  skus: SkuMonthEom[]
  integrity: IntegrityCheck | null
}

type SkuMonthEvents = {
  msku: string
  title: string | null
  total_receipts: number
  total_shipments: number
  total_returns: number
  total_damaged: number
  total_lost: number
  total_disposed: number
  total_found: number
  total_vendor_returns: number
  total_transfer: number
  total_other: number
  net_change: number
}

type EventsResponse = {
  report_month: string
  skus: SkuMonthEvents[]
}

type ReceiptCluster = {
  date: string
  location: string
  sku_set: string
  sku_count: number
  total_qty: number
  cluster_id: string
}

type ClustersResponse = {
  report_month: string
  clusters: ReceiptCluster[]
}

type LocationDetail = {
  msku: string
  title: string | null
  location: string
  disposition: string
  qty_eom: number
}

type LocationDetailResponse = {
  report_month: string
  rows: LocationDetail[]
}

type LedgerDetailRow = {
  id: number
  date: string
  fnsku: string | null
  asin: string | null
  msku: string
  title: string | null
  event_type: string
  reference_id: string | null
  quantity: number
  fulfillment_center: string
  disposition: string
  reason: string | null
  country: string | null
  reconciled_quantity: number | null
  unreconciled_quantity: number | null
  date_and_time: string | null
  store: string | null
  batch_id: number | null
}

type LedgerDetailResponse = {
  report_month: string
  rows: LedgerDetailRow[]
}

type IngestBatchInfo = {
  id: number
  project_id: number
  report_month: string
  source_filename: string
  file_hash: string
  file_size_bytes: number
  file_kind: string
  loaded_by: string | null
  loaded_at: string
  completed_at: string | null
  status: string
  rows_parsed: number
  rows_written_summary: number
  rows_written_detail: number
  rows_skipped_duplicate: number
  rows_failed_validation: number
  error_message: string | null
  consistency_check: string | null
  consistency_mismatch_count: number
}

type IngestBatchesResponse = {
  project_id: number
  batches: IngestBatchInfo[]
}

type ConsistencyMismatch = {
  msku: string
  location: string
  disposition: string
  detail_quantity: number
  summary_delta: number
  diff: number
}

type ConsistencyCheckResult = {
  report_month: string
  status: 'OK' | 'MISMATCH' | 'PENDING'
  mismatch_count: number
  mismatches: ConsistencyMismatch[]
  checked_at: string
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryLedgerPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectId, setProjectId] = useUrlParam<string>('project_id', '')
  const [month, setMonth] = useUrlParam<string>('month', '')
  const [months, setMonths] = useState<string[]>([])
  const [monthsLoaded, setMonthsLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  // BEL-417 iteration 1: surfaced load errors instead of silent failure —
  // a backend 500 used to white-screen the page (error body stored as data,
  // then `snapshot.skus.reduce(...)` threw) or fake "暂无盘点数据".
  const [loadError, setLoadError] = useState<string | null>(null)
  // Race guard: bumped on every loadData call; stale responses (user switched
  // project/month quickly) are dropped instead of overwriting fresh data.
  const loadSeq = useRef(0)
  const [activeTab, setActiveTab] = useState('snapshot')

  // Data states
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [events, setEvents] = useState<EventsResponse | null>(null)
  const [clusters, setClusters] = useState<ClustersResponse | null>(null)
  const [locationDetail, setLocationDetail] = useState<LocationDetailResponse | null>(null)
  const [detailRows, setDetailRows] = useState<LedgerDetailResponse | null>(null)
  const [batches, setBatches] = useState<IngestBatchesResponse | null>(null)
  const [consistency, setConsistency] = useState<ConsistencyCheckResult | null>(null)
  const [detailFilter, setDetailFilter] = useState<{
    msku: string
    eventType: string
  }>({ msku: 'all', eventType: 'all' })
  const [skuFilter, setSkuFilter] = useState<string>('all')

  // Load projects
  useEffect(() => {
    if (!session) return
    fetchManagedProjectsCached<ProjectOption[]>().then((items) => {
      setProjects(items)
    })
  }, [session])

  useAutoSelectFirstProject(projects, projectId, setProjectId)

  // Load months when project changes
  useEffect(() => {
    if (!projectId) return
    setMonthsLoaded(false)
    fetchLedgerJson<{ months?: string[] }>(
      `${API_BASE}/inventory-ledger/months?project_id=${projectId}`,
    )
      .then((data) => {
        const list = data.months ?? []
        setMonths(list)
        if (!month && list.length > 0) {
          setMonth(list[0])
        }
      })
      .catch((err) => {
        setMonths([])
        setLoadError(err instanceof Error ? err.message : '月份列表加载失败')
      })
      .finally(() => setMonthsLoaded(true))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load data when month changes
  const loadData = useCallback(async () => {
    if (!projectId || !month) return
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const base = `${API_BASE}/inventory-ledger`
      const params = `project_id=${projectId}&period=${month}`

      // allSettled: one failing endpoint must not take down the other four
      // tabs' data (a single 500 used to lose everything).
      const [snapRes, evtRes, clustRes, locRes, detailRes, batchRes, consRes] =
        await Promise.allSettled([
          fetchLedgerJson<SnapshotResponse>(`${base}/snapshot?${params}`),
          fetchLedgerJson<EventsResponse>(`${base}/events?${params}`),
          fetchLedgerJson<ClustersResponse>(`${base}/receipt-clusters?${params}`),
          fetchLedgerJson<LocationDetailResponse>(`${base}/location-detail?${params}`),
          fetchLedgerJson<LedgerDetailResponse>(`${base}/detail?${params}`),
          fetchLedgerJson<IngestBatchesResponse>(
            `${base}/batches?project_id=${projectId}`,
          ),
          fetchLedgerJson<ConsistencyCheckResult>(`${base}/consistency?${params}`),
        ])
      // Race guard: drop results from a stale request.
      if (seq !== loadSeq.current) return

      setSnapshot(snapRes.status === 'fulfilled' ? snapRes.value : null)
      setEvents(evtRes.status === 'fulfilled' ? evtRes.value : null)
      setClusters(clustRes.status === 'fulfilled' ? clustRes.value : null)
      setLocationDetail(locRes.status === 'fulfilled' ? locRes.value : null)
      setDetailRows(detailRes.status === 'fulfilled' ? detailRes.value : null)
      setBatches(batchRes.status === 'fulfilled' ? batchRes.value : null)
      setConsistency(consRes.status === 'fulfilled' ? consRes.value : null)

      const failures = [snapRes, evtRes, clustRes, locRes, detailRes, batchRes, consRes].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      )
      if (failures.length > 0) {
        const firstReason = failures[0].reason
        const firstMsg =
          firstReason instanceof Error ? firstReason.message : '加载失败'
        setLoadError(
          failures.length === 7 ? firstMsg : `部分数据加载失败：${firstMsg}`,
        )
      }
    } catch (err) {
      if (seq === loadSeq.current) {
        setLoadError(err instanceof Error ? err.message : '加载失败')
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [projectId, month])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Filtered location detail
  const filteredLocations = useMemo(() => {
    if (!locationDetail) return []
    if (skuFilter === 'all') return locationDetail.rows
    return locationDetail.rows.filter((r) => r.msku === skuFilter)
  }, [locationDetail, skuFilter])

  const skuOptions = useMemo(() => {
    if (!snapshot) return []
    return snapshot.skus.map((s) => s.msku)
  }, [snapshot])

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">库存盘点</h1>

        <div className="ml-auto flex items-center gap-2">
          {/* Project selector */}
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Month selector */}
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="选择月份" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="icon" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Integrity badge */}
      {snapshot?.integrity && <IntegrityBadge integrity={snapshot.integrity} />}
      {/* Cross-table consistency badge (BEL-428) */}
      {consistency && <ConsistencyBadge consistency={consistency} />}

      {/* Load error banner (BEL-417 iteration 1): real error + retry instead
          of a silent failure that looked like "no data". */}
      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
          <Button variant="outline" size="sm" onClick={loadData}>
            重试
          </Button>
        </div>
      )}

      {/* Loading */}
      {loading && !snapshot && (
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !snapshot && !loadError && projectId && monthsLoaded && (month || months.length === 0) && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Clock4 className="h-8 w-8" />
          <p className="text-sm font-medium">暂无盘点数据</p>
          <p className="text-xs">请通过「报表上传」页面上传 Amazon Detailed Inventory Ledger CSV</p>
        </div>
      )}

      {/* Tabs */}
      {snapshot && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="snapshot">月度总览</TabsTrigger>
            <TabsTrigger value="events">事件流水</TabsTrigger>
            <TabsTrigger value="clusters">入库记录</TabsTrigger>
            <TabsTrigger value="locations">仓库明细</TabsTrigger>
            <TabsTrigger value="detail">事件明细</TabsTrigger>
            <TabsTrigger value="batches">上传批次</TabsTrigger>
          </TabsList>

          <TabsContent value="snapshot">
            <SnapshotTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="events">
            <EventsTab events={events} failed={loadError !== null && events === null} />
          </TabsContent>
          <TabsContent value="clusters">
            <ClustersTab
              clusters={clusters}
              failed={loadError !== null && clusters === null}
            />
          </TabsContent>
          <TabsContent value="locations">
            <LocationsTab
              rows={filteredLocations}
              skuOptions={skuOptions}
              skuFilter={skuFilter}
              onSkuFilterChange={setSkuFilter}
              failed={loadError !== null && locationDetail === null}
            />
          </TabsContent>
          <TabsContent value="detail">
            <DetailTab
              rows={detailRows?.rows ?? []}
              filter={detailFilter}
              onFilterChange={setDetailFilter}
              failed={loadError !== null && detailRows === null}
            />
          </TabsContent>
          <TabsContent value="batches">
            <BatchesTab
              batches={batches?.batches ?? []}
              failed={loadError !== null && batches === null}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

// ── Integrity Badge ──────────────────────────────────────────────────────────

function IntegrityBadge({ integrity }: { integrity: IntegrityCheck }) {
  if (integrity.status === 'OK') {
    return (
      <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        跨月连续性校验通过
      </Badge>
    )
  }
  if (integrity.status === 'PENDING') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-300 bg-yellow-50 text-yellow-700">
        <Clock4 className="h-3.5 w-3.5" />
        无上月数据，暂无法校验
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-red-300 bg-red-50 text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      跨月连续性异常（{integrity.mismatch_count} 项）
    </Badge>
  )
}

// ── Tab 1: Snapshot ──────────────────────────────────────────────────────────

function SnapshotTab({ snapshot }: { snapshot: SnapshotResponse }) {
  const totals = useMemo(() => {
    return snapshot.skus.reduce(
      (acc, s) => ({
        qty: acc.qty + s.qty_eom,
        sellable: acc.sellable + s.sellable_qty,
        damaged: acc.damaged + s.damaged_qty,
      }),
      { qty: 0, sellable: 0, damaged: 0 },
    )
  }, [snapshot])

  return (
    <DataTableCard>
      <DataTableCardHeader
        title="月度总览"
        description={`${snapshot.sku_count} 个 SKU · 总库存 ${snapshot.total_qty}`}
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>SKU</TableHead>
              <TableHead className={DENSE_HEAD}>品名</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>期末库存</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>上月库存</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>环比</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>可售</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>损坏</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>损坏占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.skus.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-24 text-center text-muted-foreground">暂无数据</td>
              </tr>
            ) : (
              <>
                {snapshot.skus.map((sku) => {
                  const dmgPct = sku.qty_eom > 0 ? (sku.damaged_qty / sku.qty_eom) * 100 : 0
                  const isHighDamage = dmgPct > 5
                  return (
                    <TableRow key={sku.msku} className={cn(isHighDamage && 'bg-red-50/50')}>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{sku.msku}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'max-w-[200px] truncate text-xs text-muted-foreground')}>
                        {sku.title || '—'}
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right font-medium')}>{sku.qty_eom}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right text-muted-foreground')}>
                        {sku.prev_qty_eom ?? '—'}
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right')}>
                        <ChangeIndicator value={sku.change} />
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.sellable_qty}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.damaged_qty}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right', isHighDamage && 'font-medium text-red-600')}>
                        {dmgPct.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  )
                })}
                {/* Summary row */}
                <TableRow className="border-t-2 font-medium">
                  <TableCell className={DENSE_CELL} colSpan={2}>合计</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.qty}</TableCell>
                  <TableCell className={DENSE_CELL} />
                  <TableCell className={DENSE_CELL} />
                  <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.sellable}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.damaged}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right')}>
                    {totals.qty > 0 ? ((totals.damaged / totals.qty) * 100).toFixed(1) : '0.0'}%
                  </TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}

// ── Tab 2: Events ────────────────────────────────────────────────────────────

function EventsTab({ events, failed }: { events: EventsResponse | null; failed?: boolean }) {
  if (!events || events.skus.length === 0) {
    // BEL-417 iteration 1: distinguish a fetch failure from genuinely empty
    // data — the old silent catch showed "无事件数据" even on a backend 500.
    const emptyText =
      failed && !events ? '数据加载失败，请点击右上角刷新按钮重试' : '无事件数据'
    return (
      <DataTableCard>
        <DataTableCardHeader title="事件流水" />
        <DataTableCardBody>
          <Table>
            <TableBody>
              <tr>
                <td colSpan={9} className="h-24 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            </TableBody>
          </Table>
        </DataTableCardBody>
      </DataTableCard>
    )
  }

  const totals = events.skus.reduce(
    (acc, s) => ({
      receipts: acc.receipts + s.total_receipts,
      shipments: acc.shipments + s.total_shipments,
      returns: acc.returns + s.total_returns,
      damaged: acc.damaged + s.total_damaged,
      lost: acc.lost + s.total_lost,
      disposed: acc.disposed + s.total_disposed,
      net: acc.net + s.net_change,
    }),
    { receipts: 0, shipments: 0, returns: 0, damaged: 0, lost: 0, disposed: 0, net: 0 },
  )

  return (
    <DataTableCard>
      <DataTableCardHeader title="事件流水" description="各 SKU 本期事件汇总" />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>SKU</TableHead>
              <TableHead className={DENSE_HEAD}>品名</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>入库</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>出库</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>退货</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>损坏</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>丢失</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>报废</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>净变动</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.skus.map((sku) => (
              <TableRow key={sku.msku}>
                <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{sku.msku}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'max-w-[200px] truncate text-xs text-muted-foreground')}>
                  {sku.title || '—'}
                </TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right text-green-600')}>{sku.total_receipts}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right text-red-600')}>{sku.total_shipments}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.total_returns}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.total_damaged}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.total_lost}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right')}>{sku.total_disposed}</TableCell>
                <TableCell className={cn(DENSE_CELL, 'text-right font-medium')}>
                  <ChangeIndicator value={sku.net_change} />
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-medium">
              <TableCell className={DENSE_CELL} colSpan={2}>合计</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right text-green-600')}>{totals.receipts}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right text-red-600')}>{totals.shipments}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.returns}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.damaged}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.lost}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right')}>{totals.disposed}</TableCell>
              <TableCell className={cn(DENSE_CELL, 'text-right')}>
                <ChangeIndicator value={totals.net} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}

// ── Tab 3: Clusters ──────────────────────────────────────────────────────────

function ClustersTab({ clusters, failed }: { clusters: ClustersResponse | null; failed?: boolean }) {
  const emptyText =
    failed && !clusters ? '数据加载失败，请点击右上角刷新按钮重试' : '无入库记录'
  return (
    <DataTableCard>
      <DataTableCardHeader
        title="入库记录"
        description={clusters ? `${clusters.clusters.length} 个入库簇` : undefined}
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>日期</TableHead>
              <TableHead className={DENSE_HEAD}>仓库</TableHead>
              <TableHead className={DENSE_HEAD}>SKU 集合</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>SKU 数</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>总数量</TableHead>
              <TableHead className={DENSE_HEAD}>Cluster ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!clusters || clusters.clusters.length === 0 ? (
              <tr>
                <td colSpan={6} className="h-24 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            ) : (
              clusters.clusters.map((c, i) => (
                <TableRow key={`${c.date}-${c.location}-${i}`}>
                  <TableCell className={DENSE_CELL}>{c.date}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{c.location}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'max-w-[300px] truncate text-xs')}>{c.sku_set}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right')}>{c.sku_count}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right font-medium')}>{c.total_qty}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs text-muted-foreground')} title={c.cluster_id}>
                    {c.cluster_id.slice(0, 8)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}

// ── Tab 4: Locations ─────────────────────────────────────────────────────────

function LocationsTab({
  rows,
  skuOptions,
  skuFilter,
  onSkuFilterChange,
  failed,
}: {
  rows: LocationDetail[]
  skuOptions: string[]
  skuFilter: string
  onSkuFilterChange: (v: string) => void
  failed?: boolean
}) {
  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无仓库明细'
  return (
    <DataTableCard>
      <DataTableCardHeader
        title="仓库明细"
        description={`${rows.length} 条记录`}
        action={
          <Select value={skuFilter} onValueChange={onSkuFilterChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="全部 SKU" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 SKU</SelectItem>
              {skuOptions.map((sku) => (
                <SelectItem key={sku} value={sku}>
                  {sku}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>SKU</TableHead>
              <TableHead className={DENSE_HEAD}>品名</TableHead>
              <TableHead className={DENSE_HEAD}>仓库</TableHead>
              <TableHead className={DENSE_HEAD}>Disposition</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>期末数量</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="h-24 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <TableRow key={`${r.msku}-${r.location}-${r.disposition}-${i}`}>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.msku}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'max-w-[200px] truncate text-xs text-muted-foreground')}>
                    {r.title || '—'}
                  </TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.location}</TableCell>
                  <TableCell className={DENSE_CELL}>
                    <DispositionBadge disposition={r.disposition} />
                  </TableCell>
                  <TableCell className={cn(DENSE_CELL, 'text-right font-medium')}>{r.qty_eom}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}

// ── Shared components ────────────────────────────────────────────────────────

function ChangeIndicator({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  if (value > 0) return <span className="text-green-600">↑{value}</span>
  if (value < 0) return <span className="text-red-600">↓{Math.abs(value)}</span>
  return <span className="text-muted-foreground">—</span>
}

function DispositionBadge({ disposition }: { disposition: string }) {
  if (disposition === 'SELLABLE') {
    return <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700 text-xs">可售</Badge>
  }
  return <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700 text-xs">{disposition}</Badge>
}

// ── Cross-table consistency badge (BEL-428) ──────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  Receipts: '入库',
  Shipments: '出库',
  WhseTransfers: '调拨',
  CustomerReturns: '客户退货',
  VendorReturns: '供应商退货',
  Adjustments: '调整',
}

function ConsistencyBadge({ consistency }: { consistency: ConsistencyCheckResult }) {
  if (consistency.status === 'OK') {
    return (
      <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        双表对账通过（明细累加 = 汇总水位变动）
      </Badge>
    )
  }
  if (consistency.status === 'PENDING') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-300 bg-yellow-50 text-yellow-700">
        <Clock4 className="h-3.5 w-3.5" />
        本月无数据，暂无法对账
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-red-300 bg-red-50 text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      双表对账异常（{consistency.mismatch_count} 项）
    </Badge>
  )
}

// ── Tab 5: Detail（事件明细） ─────────────────────────────────────────────────

function DetailTab({
  rows,
  filter,
  onFilterChange,
  failed,
}: {
  rows: LedgerDetailRow[]
  filter: { msku: string; eventType: string }
  onFilterChange: (v: { msku: string; eventType: string }) => void
  failed?: boolean
}) {
  const skuOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.msku))
    return ['all', ...Array.from(set).sort()]
  }, [rows])
  const eventOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.event_type))
    return ['all', ...Array.from(set).sort()]
  }, [rows])
  const filtered = useMemo(() => {
    return rows.filter(
      (r) =>
        (filter.msku === 'all' || r.msku === filter.msku) &&
        (filter.eventType === 'all' || r.event_type === filter.eventType),
    )
  }, [rows, filter])

  const emptyText =
    failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无事件明细'

  return (
    <DataTableCard>
      <DataTableCardHeader
        title="事件明细"
        description={`${filtered.length} 条事件`}
        action={
          <div className="flex items-center gap-2">
            <Select
              value={filter.msku}
              onValueChange={(v) => onFilterChange({ ...filter, msku: v })}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="全部 SKU" />
              </SelectTrigger>
              <SelectContent>
                {skuOptions.map((s) => (
                  <SelectItem key={s} value={s}>{s === 'all' ? '全部 SKU' : s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filter.eventType}
              onValueChange={(v) => onFilterChange({ ...filter, eventType: v })}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                {eventOptions.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e === 'all' ? '全部类型' : (EVENT_TYPE_LABELS[e] ?? e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>日期</TableHead>
              <TableHead className={DENSE_HEAD}>SKU</TableHead>
              <TableHead className={DENSE_HEAD}>事件</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>数量</TableHead>
              <TableHead className={DENSE_HEAD}>仓库</TableHead>
              <TableHead className={DENSE_HEAD}>Disposition</TableHead>
              <TableHead className={DENSE_HEAD}>Reference ID</TableHead>
              <TableHead className={DENSE_HEAD}>批次</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="h-24 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            ) : (
              filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className={DENSE_CELL}>{r.date}</TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.msku}</TableCell>
                  <TableCell className={DENSE_CELL}>
                    <Badge variant="outline" className="text-xs">
                      {EVENT_TYPE_LABELS[r.event_type] ?? r.event_type}
                    </Badge>
                  </TableCell>
                  <TableCell className={cn(
                    DENSE_CELL,
                    'text-right font-mono text-xs',
                    r.quantity > 0 ? 'text-green-600' : r.quantity < 0 ? 'text-red-600' : undefined,
                  )}>
                    {r.quantity > 0 ? `+${r.quantity}` : r.quantity}
                  </TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{r.fulfillment_center}</TableCell>
                  <TableCell className={DENSE_CELL}>
                    <DispositionBadge disposition={r.disposition} />
                  </TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs text-muted-foreground')}>
                    {r.reference_id || '—'}
                  </TableCell>
                  <TableCell className={cn(DENSE_CELL, 'font-mono text-xs text-muted-foreground')}>
                    {r.batch_id ?? '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}

// ── Tab 6: Batches（上传批次） ────────────────────────────────────────────────

const BATCH_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  success: { label: '成功', className: 'border-green-200 bg-green-50 text-green-700' },
  failed: { label: '失败', className: 'border-red-200 bg-red-50 text-red-700' },
  running: { label: '处理中', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  pending: { label: '等待中', className: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
  partial: { label: '部分成功', className: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
}

function BatchesTab({ batches, failed }: { batches: IngestBatchInfo[]; failed?: boolean }) {
  const emptyText =
    failed ? '数据加载失败，请点击右上角刷新按钮重试' : '暂无上传记录'
  return (
    <DataTableCard>
      <DataTableCardHeader
        title="上传批次"
        description="每次 CSV 上传留档：文件指纹 / 行数 / 状态 / 对账结果，用于排查数据版本"
      />
      <DataTableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={DENSE_HEAD}>批次 ID</TableHead>
              <TableHead className={DENSE_HEAD}>报表月</TableHead>
              <TableHead className={DENSE_HEAD}>类型</TableHead>
              <TableHead className={DENSE_HEAD}>文件名</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>解析行</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>汇总行</TableHead>
              <TableHead className={cn(DENSE_HEAD, 'text-right')}>明细行</TableHead>
              <TableHead className={DENSE_HEAD}>状态</TableHead>
              <TableHead className={DENSE_HEAD}>对账</TableHead>
              <TableHead className={DENSE_HEAD}>上传时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.length === 0 ? (
              <tr>
                <td colSpan={10} className="h-24 text-center text-muted-foreground">{emptyText}</td>
              </tr>
            ) : (
              batches.map((b) => {
                const st = BATCH_STATUS_LABELS[b.status] ?? {
                  label: b.status,
                  className: 'border-gray-200 bg-gray-50 text-gray-700',
                }
                return (
                  <TableRow key={b.id}>
                    <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>{b.id}</TableCell>
                    <TableCell className={DENSE_CELL}>{b.report_month}</TableCell>
                    <TableCell className={DENSE_CELL}>
                      <Badge variant="outline" className="text-xs">
                        {b.file_kind === 'summary' ? '汇总' : b.file_kind === 'detail' ? '明细' : b.file_kind}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'max-w-[260px] truncate text-xs')} title={b.source_filename}>
                      {b.source_filename}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>{b.rows_parsed}</TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>{b.rows_written_summary}</TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right font-mono text-xs')}>{b.rows_written_detail}</TableCell>
                    <TableCell className={DENSE_CELL}>
                      <Badge variant="outline" className={cn('text-xs', st.className)}>{st.label}</Badge>
                    </TableCell>
                    <TableCell className={DENSE_CELL}>
                      {b.consistency_check ? (
                        b.consistency_check === 'ok' ? (
                          <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700 text-xs">OK</Badge>
                        ) : b.consistency_check === 'mismatch' ? (
                          <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700 text-xs">
                            异常（{b.consistency_mismatch_count}）
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{b.consistency_check}</span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-xs text-muted-foreground')}>
                      {b.loaded_at ? b.loaded_at.slice(0, 16).replace('T', ' ') : '—'}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </DataTableCardBody>
    </DataTableCard>
  )
}
