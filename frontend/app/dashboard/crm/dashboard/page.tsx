'use client'

import { useEffect, useState } from 'react'
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
import { FunnelChart, type FunnelStage } from '@/components/ui/funnel-chart'

// 漏斗主体（4 档成功路径：新建 → 联系中 → 已确认 → 已转化）
// 「已弃置」是反面信号，不进漏斗主体，在右上角单独展示
const FUNNEL_MAIN: { key: string; label: string; gradient: { offset: number; color: string }[] }[] = [
  { key: 'new', label: '新建', gradient: [{ offset: 0, color: '#38bdf8' }, { offset: 1, color: '#0ea5e9' }] },
  { key: 'contacting', label: '联系中', gradient: [{ offset: 0, color: '#818cf8' }, { offset: 1, color: '#6366f1' }] },
  { key: 'qualified', label: '已确认', gradient: [{ offset: 0, color: '#a78bfa' }, { offset: 1, color: '#8b5cf6' }] },
  { key: 'converted', label: '已转化', gradient: [{ offset: 0, color: '#34d399' }, { offset: 1, color: '#10b981' }] },
]

export default function CrmDashboardPage() {
  const client = useCrmClient()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setStats(await client.getDashboardStats())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const funnelData: FunnelStage[] = FUNNEL_MAIN.map((m) => ({
    label: m.label,
    value: stats?.leadFunnel[m.key] ?? 0,
    gradient: m.gradient,
  }))

  const discarded = stats?.leadFunnel.discarded ?? 0

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

      {/* 线索漏斗 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">线索漏斗</CardTitle>
            {discarded > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                本期弃置 {discarded}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {funnelData.some((d) => d.value > 0) ? (
            <FunnelChart
              data={funnelData}
              className="mx-auto w-full max-w-3xl"
              color="var(--chart-1)"
              edges="curved"
              layers={1}
              orientation="horizontal"
            />
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
