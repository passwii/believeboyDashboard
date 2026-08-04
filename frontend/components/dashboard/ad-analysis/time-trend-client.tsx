'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { LineChart, TimerReset } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'


type TimeTrendItem = {
  report_date: string
  clicks: number
  spend: number
  cpc: number
  running_spend: number
}

type TimeTrendResponse = {
  project_id: number
  country: string
  summary: TimeTrendItem[]
  comparison?: {
    current_start?: string | null
    current_end?: string | null
    previous_start?: string | null
    previous_end?: string | null
    spend_change_ratio?: number | null
    clicks_change_ratio?: number | null
    cpc_change_ratio?: number | null
    summary?: string | null
  } | null
}


export function AdAnalysisTimeTrendClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const focusDate = searchParams.get('focusDate') || ''

  const [data, setData] = useState<TimeTrendResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    // BEL-421: cache key is user-scoped; wait for session to avoid an unknown-scope double fetch
    if (status === 'loading') return
    let active = true

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const query = new URLSearchParams({
          project_id: projectId,
          country,
        })
        if (dateFrom) query.set('date_from', dateFrom)
        if (dateTo) query.set('date_to', dateTo)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<TimeTrendResponse>('time-trend', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '趋势分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [country, dateFrom, dateTo, projectId, session, status])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载趋势分析..." />
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        {error}
      </div>
    )
  }
  if (!data || data.summary.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有趋势数据。" />

  const latest = data.summary[data.summary.length - 1]
  const comparison = data.comparison

  return (
    <div className="space-y-5">
      <AdAnalysisContextBanner
        items={focusDate ? [{ label: '当前聚焦日期', value: focusDate }] : []}
      />
      {comparison ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">周期对比</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              当前周期 {comparison.current_start} ~ {comparison.current_end} 对比上一周期{' '}
              {comparison.previous_start} ~ {comparison.previous_end}
            </p>
            {comparison.summary ? (
              <p className="text-sm leading-6 text-foreground/90">{comparison.summary}</p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border/70 px-3 py-3 text-sm">
                <p className="text-muted-foreground">花费变化</p>
                <p className="mt-1 font-medium">
                  {comparison.spend_change_ratio != null
                    ? `${(comparison.spend_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-lg border border-border/70 px-3 py-3 text-sm">
                <p className="text-muted-foreground">点击变化</p>
                <p className="mt-1 font-medium">
                  {comparison.clicks_change_ratio != null
                    ? `${(comparison.clicks_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-lg border border-border/70 px-3 py-3 text-sm">
                <p className="text-muted-foreground">CPC 变化</p>
                <p className="mt-1 font-medium">
                  {comparison.cpc_change_ratio != null
                    ? `${(comparison.cpc_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">累计花费</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            ${latest.running_spend.toFixed(2)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">最新单日点击</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{latest.clicks}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">最新单日 CPC</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">${latest.cpc.toFixed(2)}</CardContent>
        </Card>
      </div>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="time-trend-deferred-table">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <LineChart className="h-4 w-4 text-primary" />
            <CardTitle className="text-lg">按日趋势</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>Clicks</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>CPC</TableHead>
                  <TableHead>Running Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.summary.map((item) => (
                  <TableRow
                    key={item.report_date}
                    className={focusDate === item.report_date ? 'bg-muted/40' : undefined}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <TimerReset className="h-3.5 w-3.5 text-muted-foreground" />
                        {item.report_date}
                      </div>
                    </TableCell>
                    <TableCell>{item.clicks}</TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.cpc.toFixed(2)}</TableCell>
                    <TableCell>${item.running_spend.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 手机端：卡片列表 */}
          <div className="lg:hidden space-y-2">
            {data.summary.map((item) => (
              <div
                key={item.report_date}
                className={cn(
                  'dashboard-surface p-3',
                  focusDate === item.report_date ? 'border-primary/50 bg-primary/5' : ''
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <TimerReset className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-sm">{item.report_date}</span>
                  </div>
                  {focusDate === item.report_date && (
                    <span className="text-xs text-primary">当前</span>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Clicks</span>
                    <div className="font-medium">{item.clicks}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Spend</span>
                    <div className="font-medium">${item.spend.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">CPC</span>
                    <div className="font-medium">${item.cpc.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Running</span>
                    <div className="font-medium">${item.running_spend.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      </DeferredSection>
    </div>
  )
}
