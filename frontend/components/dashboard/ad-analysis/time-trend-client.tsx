'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { LineChart, TimerReset } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile } from '@/components/terminal/term-controls'
import { EmptyState } from '@/components/ui/empty-state'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { TermRefreshStatus } from '@/components/dashboard/ad-analysis/term-chrome'
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
  const refreshKey = useAdClientRefreshKey()

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
  }, [country, dateFrom, dateTo, projectId, session, status, refreshKey])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading && !data) return <EmptyState rowHeight="lg" message="正在加载趋势分析..." />
  if (error && !data) {
    return (
      <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
        ERR · {error}
      </div>
    )
  }
  if (!data) return <EmptyState rowHeight="lg" message="当前没有趋势数据。" />
  if (data.summary.length === 0) {
    return (
      <>
        <TermRefreshStatus loading={loading} error={error} hasData />
        <EmptyState rowHeight="lg" message="当前没有趋势数据。" />
      </>
    )
  }

  const latest = data.summary[data.summary.length - 1]
  const comparison = data.comparison

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TermRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={focusDate ? [{ label: '当前聚焦日期', value: focusDate }] : []}
      />
      {comparison ? (
        <TermPanel title="周期对比" bodyClassName="p-2">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              当前周期 {comparison.current_start} ~ {comparison.current_end} 对比上一周期{' '}
              {comparison.previous_start} ~ {comparison.previous_end}
            </p>
            {comparison.summary ? (
              <p className="text-sm leading-6 text-foreground/90">{comparison.summary}</p>
            ) : null}
            {/* BLF-611：手机端对比指标一行两个（总则 1），第三项占满一行；sm+ 三列不变 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-none border border-term-border bg-term-panel px-2 py-1.5 font-mono text-xs">
                <p className="text-term-muted">花费变化</p>
                <p className="mt-1 font-medium">
                  {comparison.spend_change_ratio != null
                    ? `${(comparison.spend_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-none border border-term-border bg-term-panel px-2 py-1.5 font-mono text-xs">
                <p className="text-term-muted">点击变化</p>
                <p className="mt-1 font-medium">
                  {comparison.clicks_change_ratio != null
                    ? `${(comparison.clicks_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-lg border border-term-border px-3 py-3 text-sm last:col-span-2 sm:last:col-span-1">
                <p className="text-term-muted">CPC 变化</p>
                <p className="mt-1 font-medium">
                  {comparison.cpc_change_ratio != null
                    ? `${(comparison.cpc_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
            </div>
          </div>
        </TermPanel>
      ) : null}
      {/* BLF-611：手机端 KPI 一行两个，第三项占满；sm+ 三列不变；数字降级防挤压 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <TermKpiTile label="累计花费" value={`$${latest.running_spend.toFixed(2)}`} />
        <TermKpiTile label="最新单日点击" value={String(latest.clicks)} />
        <TermKpiTile label="最新单日 CPC" value={`$${latest.cpc.toFixed(2)}`} />
      </div>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="time-trend-deferred-table">
      <TermPanel title="按日趋势" bodyClassName="p-0">
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
                    className={focusDate === item.report_date ? 'bg-term-raised' : undefined}
                  >
                    <TableCell className="font-mono text-xs font-medium text-term-text">
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
                  'rounded-none border border-term-border bg-term-panel p-2',
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
                {/* BLF-611：<640px 时 4 列改 2×2，避免金额被压缩折行 */}
                <div className="grid grid-cols-2 gap-2 mt-2 text-xs sm:grid-cols-4">
                  <div>
                    <span className="text-term-muted">Clicks</span>
                    <div className="font-mono text-xs font-medium text-term-text">{item.clicks}</div>
                  </div>
                  <div>
                    <span className="text-term-muted">Spend</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.spend.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-term-muted">CPC</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.cpc.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-term-muted">Running</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.running_spend.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
      </TermPanel>
      </DeferredSection>
    </div>
  )
}
