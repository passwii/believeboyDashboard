'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, RefreshCcw, Sparkles, TrendingUp, Users } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { DashboardStats, LifecycleBoard } from '@/lib/crm/types'
import { StatCard, StatCardRow } from '@/components/ui/stat-card'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { numericCell } from '@/components/ui/table-presets'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FunnelChart } from '@/components/ui/funnel-chart'
import { buildLeadStageFunnel, leadConversionRate, leadFunnelStepRates } from '@/lib/crm/method/lead-funnel'
import { FunnelStageDrawer } from '@/components/crm/funnel-stage-drawer'
import { LifecycleBoardSection } from '@/components/crm/lifecycle-board'

/** 数字紧凑显示：12400 → "1.2万"，小数字原样。 */
const compact = (v: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(v)

/** 后端阶段 key → 展示名（与 LEAD_STATUS_LABELS 一致，BLF-516 决策 1）。 */
const STAGE_LABELS: Record<string, string> = {
  new: '新线索',
  contacting: '联系中',
  qualified: '已验证',
  converted: '已转化',
}

export default function CrmDashboardPage() {
  const client = useCrmClient()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [lifecycle, setLifecycle] = useState<LifecycleBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, lifecycleRes] = await Promise.all([
        client.getDashboardStats(),
        client.getLifecycleBoard(),
      ])
      setStats(statsRes)
      setLifecycle(lifecycleRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // 漏斗：阶段漏斗（raw counts，不累计）——BLF-516 决策 4：raw 宽度直接看出
  // 「哪一级堆了人、哪一级掉得快」，4 级粗粒度下不会忽宽忽窄。
  const funnelStages = buildLeadStageFunnel(stats?.leadFunnel ?? {})
  const funnelTotal = funnelStages.reduce((s, st) => s + st.value, 0)
  const discarded = stats?.leadFunnel.discarded ?? 0
  const convRate = leadConversionRate(stats?.leadFunnel ?? {})

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* §8.1 PageHeader 原语：标题 + 描述 + 操作区 */}
      <PageHeader
        kicker="CRM"
        title="数据看板"
        description="线索漏斗 / 本月新增 / 跟进活跃度 / 每销售业绩（仅管理员可见）"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCcw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            刷新
          </Button>
        }
      />

      {error && <ErrorState title="加载失败" message={error} onRetry={() => void load()} />}

      {/* 本月新增 + 跟进活跃度（§8.3 StatCardRow 指标卡行） */}
      <StatCardRow>
        <StatCard
          title="本月新增客户"
          value={String(stats?.newThisMonth.newCustomers ?? 0)}
          icon={<Users className="h-4 w-4" />}
          color="sky"
        />
        <StatCard
          title="本月新增线索"
          value={String(stats?.newThisMonth.newLeads ?? 0)}
          icon={<Sparkles className="h-4 w-4" />}
          color="amber"
        />
        <StatCard
          title="本月转化"
          value={String(stats?.newThisMonth.convertedCount ?? 0)}
          icon={<TrendingUp className="h-4 w-4" />}
          color="emerald"
        />
        <StatCard
          title="近 7 天跟进"
          value={String(stats?.followActivity.followCount7d ?? 0)}
          icon={<BarChart3 className="h-4 w-4" />}
          color="rose"
        />
      </StatCardRow>

      {/* 线索漏斗（阶段口径：各状态当前计数） */}
      <div className="dashboard-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <div className="space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">线索漏斗</h2>
            <p className="text-xs text-muted-foreground">
              阶段口径：各阶段当前线索数，点击某级查看停留时长 / 卡点复盘明细
            </p>
          </div>
          <div className="flex items-center gap-2">
            {convRate !== null && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <TrendingUp className="h-3 w-3" />
                整体转化率 {(convRate * 100).toFixed(1)}%
              </span>
            )}
            {discarded > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-0.5 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                本期弃置 {discarded}
              </span>
            )}
          </div>
        </div>
        <div className="p-5 pt-4">
          {funnelTotal > 0 ? (
            <>
              <FunnelChart
                data={funnelStages}
                className="mx-auto w-full max-w-3xl"
                color="var(--chart-1)"
                edges="curved"
                layers={2}
                onStageClick={(i) => {
                  const stageKey = funnelStages[i]?.stage
                  if (stageKey) setSelectedStage(stageKey)
                }}
                orientation="horizontal"
                formatValue={compact}
              />
              {/* 逐级转化率：相邻阶段的流转效率，定位漏斗卡点 */}
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {leadFunnelStepRates(funnelStages).map((rate, i) => {
                  const from = funnelStages[i]?.label ?? ''
                  const to = funnelStages[i + 1]?.label ?? ''
                  const pct = rate === null ? 0 : Math.round(rate * 100)
                  return (
                    <div
                      key={`${from}-${to}`}
                      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-muted-foreground">
                          {from} → {to}
                        </span>
                        <span className="font-semibold text-foreground">
                          {rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-emerald-500/70 transition-[width] duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
              {loading ? '加载中…' : '暂无漏斗数据'}
            </div>
          )}
        </div>
      </div>

      {/* 每销售业绩 */}
      <div className="dashboard-surface">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold tracking-tight">每销售业绩</h2>
        </div>
        <div className="p-5 pt-4">
          {stats && stats.perOwner.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>负责人</TableHead>
                  <TableHead className="text-right">名下客户数</TableHead>
                  <TableHead className="text-right">本月转化</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.perOwner.map((p) => (
                  <TableRow key={p.ownerId}>
                    <TableCell className="font-medium">{p.ownerName ?? p.ownerId}</TableCell>
                    <TableCell className={numericCell}>{p.customerCount}</TableCell>
                    <TableCell className={numericCell}>{p.convertedThisMonth}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {loading ? '加载中…' : '暂无业绩数据'}
            </p>
          )}
        </div>
      </div>

      {/* 生命周期（P8，BLF-520）：创建 → 首次跟进/转化/流失 时间分布 */}
      <LifecycleBoardSection board={lifecycle} loading={loading} />

      {/* 漏斗二层复盘面板（BLF-518）：点击漏斗某级展开 */}
      <FunnelStageDrawer
        open={selectedStage !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedStage(null)
        }}
        stage={selectedStage ?? ''}
        stageLabel={selectedStage ? (STAGE_LABELS[selectedStage] ?? selectedStage) : ''}
      />
    </div>
  )
}
