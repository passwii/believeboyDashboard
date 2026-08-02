'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, RefreshCcw, Sparkles, TrendingUp, Users } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { DashboardStats } from '@/lib/crm/types'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FunnelChart } from '@/components/ui/funnel-chart'
import { buildLeadFunnelStages, leadConversionRate, leadFunnelStepRates } from '@/lib/crm/method/lead-funnel'

/** 数字紧凑显示：12400 → "1.2万"，小数字原样。 */
const compact = (v: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(v)

export default function CrmDashboardPage() {
  const client = useCrmClient()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStats(await client.getDashboardStats())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // 漏斗：累计转化口径（线索总量 → 跟进联系 → 验证 → 转化），恒单调收窄。
  const funnelStages = buildLeadFunnelStages(stats?.leadFunnel ?? {})
  const funnelTotal = funnelStages[0]?.value ?? 0
  const discarded = stats?.leadFunnel.discarded ?? 0
  const convRate = leadConversionRate(stats?.leadFunnel ?? {})

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">CRM 数据看板</h1>
          <p className="text-sm text-muted-foreground">
            线索漏斗 / 本月新增 / 跟进活跃度 / 每销售业绩（仅管理员可见）
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <RefreshCcw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          刷新
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* 本月新增 + 跟进活跃度 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
      </div>

      {/* 线索漏斗（累计转化口径） */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <CardTitle className="text-base">线索漏斗</CardTitle>
              <p className="text-xs text-muted-foreground">
                累计口径：每层 = 到达该阶段及以上的线索数，逐级收窄
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
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs text-slate-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                  本期弃置 {discarded}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {funnelTotal > 0 ? (
            <>
              <FunnelChart
                data={funnelStages}
                className="mx-auto w-full max-w-3xl"
                color="var(--chart-1)"
                edges="curved"
                layers={2}
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
        </CardContent>
      </Card>

      {/* 每销售业绩 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">每销售业绩</CardTitle>
        </CardHeader>
        <CardContent>
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
                    <TableCell className="text-right">{p.customerCount}</TableCell>
                    <TableCell className="text-right">{p.convertedThisMonth}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {loading ? '加载中…' : '暂无业绩数据'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
