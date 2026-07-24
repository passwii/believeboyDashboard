'use client'

import { useEffect, useState } from 'react'
import { BarChart3, RefreshCcw, Sparkles, TrendingUp, Users } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
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

// 线索漏斗状态 → 中文标签 + 柱色
const FUNNEL_META: { key: string; label: string; color: string }[] = [
  { key: 'new', label: '新建', color: '#38bdf8' },
  { key: 'contacting', label: '联系中', color: '#818cf8' },
  { key: 'qualified', label: '已确认', color: '#a78bfa' },
  { key: 'converted', label: '已转化', color: '#34d399' },
  { key: 'discarded', label: '已弃置', color: '#94a3b8' },
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

  const funnelData = FUNNEL_META.map((m) => ({
    label: m.label,
    value: stats?.leadFunnel[m.key] ?? 0,
    color: m.color,
  }))

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
          <CardTitle className="text-base">线索漏斗</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelData} margin={{ top: 12, right: 8, left: -16, bottom: 8 }}>
                <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.18)" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 12, fill: '#71717a' }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 11, fill: '#71717a' }}
                  allowDecimals={false}
                />
                <Tooltip cursor={{ fill: 'rgba(148,163,184,0.12)' }} />
                <Bar dataKey="value" name="线索数" radius={[4, 4, 0, 0]}>
                  {funnelData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
