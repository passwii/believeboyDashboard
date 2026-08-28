'use client'

/**
 * 漏斗二层复盘面板（BLF-518）——右侧抽屉。
 *
 * 按 BLF-516 设计决策定稿：
 * - 决策 2：面板位置 = 右侧抽屉 Sheet（复用 crm-overview-drawer 范式，sm:max-w-xl）
 * - 决策 3：默认「卡点列表」（停留时长降序，卡最久在前）+「最近动作」视图切换；
 *   标题区摘要 = 平均停留 X 天 · 卡住 N 条（超 stuckDays 天未动）· 本期流入/流出
 *
 * 数据源：GET /crm/dashboard/funnel/stage/{stage}（BLF-517 后端 service）。
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowDownWideNarrow, Clock3, Hourglass, RefreshCcw, UserRound } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/error-state'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { FunnelStageDetail, StageLeadItem } from '@/lib/crm/types'
import { formatRelativeTime } from '@/lib/crm/method/format'

export interface FunnelStageDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 后端阶段 key：new / contacting / qualified / converted。 */
  stage: string
  /** 阶段展示名（新线索/联系中/已验证/已转化）。 */
  stageLabel: string
}

const PAGE_SIZE = 10

/** 停留时长展示：7.5 → "7.5 天"，整数 → "7 天"。 */
function formatDwell(days?: number): string {
  if (days == null) return '—'
  const rounded = Math.round(days * 10) / 10
  return `${rounded} 天`
}

function LeadRow({ item, rank }: { item: StageLeadItem; rank: number }) {
  return (
    <TableRow className={item.isStuck ? 'bg-term-warn/[0.06]' : undefined}>
      <TableCell>
        <div className="flex items-center gap-1.5">
          {rank <= 3 && (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-term-warn/40 font-mono text-[11px] tabular-nums text-term-warn">
              {rank}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate font-medium text-term-text">{item.name}</div>
            {item.company && (
              <div className="truncate text-xs text-term-faint">{item.company}</div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <UserRound className="h-3.5 w-3.5 shrink-0 opacity-60" />
          {item.ownerName ?? '未分配'}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Hourglass className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={1.75} aria-hidden />
          <span
            className={
              item.isStuck
                ? 'font-mono text-sm font-semibold tabular-nums text-term-warn'
                : 'font-mono text-sm tabular-nums text-term-muted'
            }
          >
            {formatDwell(item.dwellDays)}
          </span>
          {item.isStuck && <Badge variant="warning">卡住</Badge>}
        </div>
      </TableCell>
      <TableCell>
        {item.lastActionAt ? (
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock3 className="h-3 w-3 shrink-0 opacity-60" />
              {formatRelativeTime(item.lastActionAt)}
            </div>
            {item.lastActionContent && (
              <div className="mt-0.5 max-w-[15rem] truncate text-xs text-muted-foreground/80">
                {item.lastActionContent}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/60">无跟进记录</span>
        )}
      </TableCell>
      <TableCell>
        {item.nextFollowAt ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatRelativeTime(item.nextFollowAt)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

export function FunnelStageDrawer({
  open,
  onOpenChange,
  stage,
  stageLabel,
}: FunnelStageDrawerProps) {
  const client = useCrmClient()
  const [sortBy, setSortBy] = useState<'dwell' | 'recent'>('dwell')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<FunnelStageDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 用 ref 持有最新加载器：client 来自 context（mock 环境下每次渲染是新对象），
  // 若把 client 放进 useEffect 依赖，会因引用变化导致 effect 反复触发。
  // 这里 effect 只依赖 open，加载器内部读取最新闭包值。
  const loadRef = useRef<() => void>(() => {})
  loadRef.current = () => {
    setLoading(true)
    setError(null)
    void client
      .getFunnelStageDetail({ stage, sortBy, page, pageSize: PAGE_SIZE })
      .then((d) => setData(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载阶段明细失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (open) loadRef.current()
  }, [open, sortBy, page])

  // 切换排序视图时回到第一页
  function handleSortChange(next: 'dwell' | 'recent') {
    if (next === sortBy) return
    setSortBy(next)
    setPage(1)
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* BLF-837：抽屉终端规格——零圆角、term 边界与面板底色 */}
      <SheetContent className="w-full gap-0 rounded-none border-term-border bg-term-panel p-0 sm:max-w-xl">
        <SheetHeader className="rounded-none border-b border-term-border px-3 py-2">
          <div className="flex items-center justify-between gap-2 pr-8">
            <SheetTitle className="truncate text-sm uppercase tracking-wider text-term-muted">
              {stageLabel} · 复盘明细
            </SheetTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => loadRef.current()}
              disabled={loading}
              className="h-8 rounded-none font-mono text-xs text-term-muted hover:text-term-text"
            >
              <RefreshCcw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              刷新
            </Button>
          </div>
          {/* 摘要：平均停留 · 卡住 N 条 · 本期流入/流出（终端单色 chips） */}
          {data && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-xs">
              <span className="inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 tabular-nums text-term-muted">
                <Hourglass className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                平均停留 {data.avgDwellDays != null ? `${data.avgDwellDays} 天` : '—'}
              </span>
              <span
                className={
                  data.stuckCount > 0
                    ? 'inline-flex items-center gap-1 border border-term-warn/40 px-1.5 py-0.5 tabular-nums text-term-warn'
                    : 'inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 tabular-nums text-term-muted'
                }
              >
                卡住 {data.stuckCount} 条（超 {data.stuckDays} 天未动）
              </span>
              <span className="inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 tabular-nums text-term-muted">
                本期流入 {data.inflow}
              </span>
              {data.outflow != null && (
                <span className="inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 tabular-nums text-term-muted">
                  流出 {data.outflow}
                </span>
              )}
            </div>
          )}
        </SheetHeader>

        <div className="px-5 pt-3">
          <Tabs value={sortBy} onValueChange={(v) => handleSortChange(v as 'dwell' | 'recent')}>
            <TabsList variant="term" className="grid h-auto w-full grid-cols-2">
              <TabsTrigger value="dwell" variant="term">
                <ArrowDownWideNarrow aria-hidden />
                卡点列表
              </TabsTrigger>
              <TabsTrigger value="recent" variant="term">
                <Clock3 aria-hidden />
                最近动作
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <ErrorState title="加载失败" message={error} onRetry={() => loadRef.current()} />
          ) : loading && !data ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : data && data.leads.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              该阶段暂无线索明细
            </p>
          ) : data ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>线索</TableHead>
                    <TableHead>负责人</TableHead>
                    <TableHead>停留</TableHead>
                    <TableHead>最后动作</TableHead>
                    <TableHead>下次跟进</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.leads.map((item, i) => (
                    <LeadRow
                      key={item.id}
                      item={item}
                      rank={(data.page - 1) * data.pageSize + i + 1}
                    />
                  ))}
                </TableBody>
              </Table>

              {/* 分页 */}
              {data.total > data.pageSize && (
                <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    共 {data.total} 条 · 第 {data.page}/{totalPages} 页
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={data.page <= 1 || loading}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={data.page >= totalPages || loading}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default FunnelStageDrawer
