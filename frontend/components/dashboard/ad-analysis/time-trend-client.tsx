'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { TimerReset } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import {
  WarmErrorBar,
  WarmEmptyState,
  WarmPanel,
  WarmKpiTile,
  WarmRefreshStatus,
  WarmTable,
  WarmBody,
  WarmCell,
  WarmHead,
  WarmTHead,
  WarmRow,
  WarmNumber,
  WarmDeferredSection,
} from './warm-analysis'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'

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

  const [dataResult, setDataResult] = useState<{ signature: string; value: TimeTrendResponse } | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(null)
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId, country, dateFrom, dateTo,
    sessionUser?.id ?? null, sessionUser?.roleType ?? null, sessionUser?.name ?? null,
  ])
  const data = dataResult?.signature === querySignature ? dataResult.value : null
  const error = errorResult?.signature === querySignature ? errorResult.message : null
  const isLoading = loading || (Boolean(projectId) && status !== 'loading' && !data && !error)

  useEffect(() => {
    if (!projectId) return
    // BEL-421: cache key is user-scoped; wait for session to avoid an unknown-scope double fetch
    if (status === 'loading') return
    let active = true
    setDataResult((current) => current?.signature === querySignature ? current : null)
    setErrorResult(null)

    async function load() {
      setLoading(true)
      try {
        const query = new URLSearchParams({
          project_id: projectId,
          country,
        })
        if (dateFrom) query.set('date_from', dateFrom)
        if (dateTo) query.set('date_to', dateTo)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<TimeTrendResponse>('time-trend', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '趋势分析加载失败',
          })
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [country, dateFrom, dateTo, projectId, querySignature, session, status, refreshKey])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载趋势分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有趋势数据。" />
  if (data.summary.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有趋势数据。" />
      </>
    )
  }

  const latest = data.summary[data.summary.length - 1]
  const comparison = data.comparison

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="time-trend">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={focusDate ? [{ label: '当前聚焦日期', value: focusDate }] : []}
      />
      {comparison ? (
        <WarmPanel title="周期对比" bodyClassName="p-2">
          <div className="space-y-2">
            <p className="text-sm text-[var(--warm-ledger-color-text-muted)]">
              当前周期 {comparison.current_start} ~ {comparison.current_end} 对比上一周期{' '}
              {comparison.previous_start} ~ {comparison.previous_end}
            </p>
            {comparison.summary ? (
              <p className="text-sm leading-6 text-[var(--warm-ledger-color-text-soft)]">{comparison.summary}</p>
            ) : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              <div className="rounded-[var(--warm-ledger-radius-inner)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2 py-1.5 font-sans text-xs">
                <p className="text-[var(--warm-ledger-color-text-muted)]">花费变化</p>
                <p className="mt-1 font-medium">
                  {comparison.spend_change_ratio != null
                    ? `${(comparison.spend_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-[var(--warm-ledger-radius-inner)] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-2 py-1.5 font-sans text-xs">
                <p className="text-[var(--warm-ledger-color-text-muted)]">点击变化</p>
                <p className="mt-1 font-medium">
                  {comparison.clicks_change_ratio != null
                    ? `${(comparison.clicks_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
              <div className="rounded-[var(--warm-ledger-radius-inner)] border border-[var(--warm-ledger-color-hairline)] px-3 py-3 font-sans text-sm">
                <p className="text-[var(--warm-ledger-color-text-muted)]">CPC 变化</p>
                <p className="mt-1 font-medium">
                  {comparison.cpc_change_ratio != null
                    ? `${(comparison.cpc_change_ratio * 100).toFixed(2)}%`
                    : '-'}
                </p>
              </div>
            </div>
          </div>
        </WarmPanel>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <WarmKpiTile label="累计花费" value={`$${latest.running_spend.toFixed(2)}`} />
        <WarmKpiTile label="最新单日点击" value={String(latest.clicks)} />
        <WarmKpiTile label="最新单日 CPC" value={`$${latest.cpc.toFixed(2)}`} />
      </div>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="time-trend-deferred-table">
      <WarmPanel title="按日趋势" bodyClassName="p-0">
          <div>
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead numeric>日期</WarmHead>
                  <WarmHead numeric>Clicks</WarmHead>
                  <WarmHead numeric>Spend</WarmHead>
                  <WarmHead numeric>CPC</WarmHead>
                  <WarmHead numeric>Running Spend</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {data.summary.map((item) => (
                  <WarmRow
                    key={item.report_date}
                    className={focusDate === item.report_date ? 'bg-[var(--warm-ledger-color-raised)]' : undefined}
                  >
                    <WarmCell className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                      <div className="flex items-center gap-2">
                        <TimerReset className="h-3.5 w-3.5 text-[var(--warm-ledger-color-text-muted)]" />
                        <WarmNumber>{item.report_date}</WarmNumber>
                      </div>
                    </WarmCell>
                    <WarmCell numeric>{item.clicks}</WarmCell>
                    <WarmCell numeric>${item.spend.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.cpc.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.running_spend.toFixed(2)}</WarmCell>
                  </WarmRow>
                ))}
              </WarmBody>
            </WarmTable>
          </div>

      </WarmPanel>
      </WarmDeferredSection>
    </div>
  )
}
