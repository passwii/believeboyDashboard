'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

// ── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryLedgerPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectId, setProjectId] = useUrlParam<string>('project_id', '')
  const [month, setMonth] = useUrlParam<string>('month', '')
  const [months, setMonths] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('snapshot')

  // Data states
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [events, setEvents] = useState<EventsResponse | null>(null)
  const [clusters, setClusters] = useState<ClustersResponse | null>(null)
  const [locationDetail, setLocationDetail] = useState<LocationDetailResponse | null>(null)
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
    fetch(`${API_BASE}/inventory-ledger/months?project_id=${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        setMonths(data.months || [])
        if (!month && data.months?.length > 0) {
          setMonth(data.months[0])
        }
      })
      .catch(() => setMonths([]))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load data when month changes
  const loadData = useCallback(async () => {
    if (!projectId || !month) return
    setLoading(true)
    try {
      const base = `${API_BASE}/inventory-ledger`
      const params = `project_id=${projectId}&report_month=${month}`

      const [snapRes, evtRes, clustRes, locRes] = await Promise.all([
        fetch(`${base}/snapshot?${params}`).then((r) => r.json()),
        fetch(`${base}/events?${params}`).then((r) => r.json()),
        fetch(`${base}/receipt-clusters?${params}`).then((r) => r.json()),
        fetch(`${base}/location-detail?${params}`).then((r) => r.json()),
      ])
      setSnapshot(snapRes)
      setEvents(evtRes)
      setClusters(clustRes)
      setLocationDetail(locRes)
    } catch {
      // silently fail — empty states will show
    } finally {
      setLoading(false)
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

      {/* Loading */}
      {loading && !snapshot && (
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !snapshot && projectId && month && (
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
          </TabsList>

          <TabsContent value="snapshot">
            <SnapshotTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="events">
            <EventsTab events={events} />
          </TabsContent>
          <TabsContent value="clusters">
            <ClustersTab clusters={clusters} />
          </TabsContent>
          <TabsContent value="locations">
            <LocationsTab
              rows={filteredLocations}
              skuOptions={skuOptions}
              skuFilter={skuFilter}
              onSkuFilterChange={setSkuFilter}
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

function EventsTab({ events }: { events: EventsResponse | null }) {
  if (!events || events.skus.length === 0) {
    return (
      <DataTableCard>
        <DataTableCardHeader title="事件流水" />
        <DataTableCardBody>
          <Table>
            <TableBody>
              <tr>
                <td colSpan={9} className="h-24 text-center text-muted-foreground">无事件数据</td>
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

function ClustersTab({ clusters }: { clusters: ClustersResponse | null }) {
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
                <td colSpan={6} className="h-24 text-center text-muted-foreground">无入库记录</td>
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
}: {
  rows: LocationDetail[]
  skuOptions: string[]
  skuFilter: string
  onSkuFilterChange: (v: string) => void
}) {
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
                <td colSpan={5} className="h-24 text-center text-muted-foreground">无仓库明细</td>
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
