'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AlertTriangle } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import {
  WarmErrorBar,
  WarmEmptyState,
  WarmPanel,
  WarmKpiTile,
  WarmPill,
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

type TrafficQualityItem = {
  campaign_name: string
  status: string
  total_impressions: number
  valid_impressions: number
  invalid_impressions: number
  invalid_impression_rate: number
  total_clicks: number
  valid_clicks: number
  invalid_clicks: number
  invalid_click_rate: number
  risk_level: string
  next_step: string
}

type TrafficSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type TrafficQualityResponse = {
  project_id: number
  country: string
  summary_cards: TrafficSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: TrafficQualityItem[]
}

function riskVariant(level: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (level === '高风险') return 'destructive'
  if (level === '中风险') return 'secondary'
  return 'outline'
}

export function AdAnalysisTrafficQualityClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''

  const [dataResult, setDataResult] = useState<{
    signature: string
    value: TrafficQualityResponse
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(
    null
  )
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId,
    country,
    dateFrom,
    dateTo,
    campaignFilter,
    sessionUser?.id ?? null,
    sessionUser?.roleType ?? null,
    sessionUser?.name ?? null,
  ])
  const data = dataResult?.signature === querySignature ? dataResult.value : null
  const error = errorResult?.signature === querySignature ? errorResult.message : null
  const isLoading = loading || (Boolean(projectId) && status !== 'loading' && !data && !error)

  useEffect(() => {
    if (!projectId) return
    // BEL-421: cache key is user-scoped; wait for session to avoid an unknown-scope double fetch
    if (status === 'loading') return
    let active = true
    setDataResult((current) => (current?.signature === querySignature ? current : null))
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
        if (campaignFilter) query.set('campaign', campaignFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<TrafficQualityResponse>(
          'traffic-quality',
          query,
          session
        )
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '流量质量分析加载失败',
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
  }, [
    campaignFilter,
    country,
    dateFrom,
    dateTo,
    projectId,
    querySignature,
    session,
    status,
    refreshKey,
  ])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载流量质量分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有流量质量明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有流量质量明细。" />
      </>
    )
  }

  const narrativeSections = data.narrative_sections ?? []

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="traffic-quality">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []}
      />
      {/* 桌面端汇总卡固定四列，金额由 Warm 数字字体完整展示 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.summary_cards.map((card) => (
          <WarmKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <WarmDeferredSection
        fallbackHeight="h-[280px]"
        data-testid="traffic-quality-deferred-narrative"
      >
        <WarmPanel title="流量质量层分析" bodyClassName="p-2">
          <div className="divide-y divide-[var(--warm-ledger-color-hairline)]">
            {narrativeSections.map((section) => (
              <div key={section.title} className="py-2 first:pt-0 last:pb-0">
                <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                  {section.title}
                </p>
                <p className="mt-1 font-sans text-xs leading-5 text-[var(--warm-ledger-color-text-muted)]">
                  {section.summary}
                </p>
                <div className="mt-1 space-y-0.5 font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                  {section.evidence.map((evidence) => (
                    <p key={evidence}>- {evidence}</p>
                  ))}
                </div>
                {section.action ? (
                  <p className="mt-1 font-sans text-xs leading-5 text-[var(--warm-ledger-color-text-muted)]">
                    动作：{section.action}
                  </p>
                ) : null}
                <div className="mt-2">
                  <AdAnalysisDrillLinks
                    links={[
                      {
                        href: buildAnalysisDrillHref(
                          section.drill_to || '',
                          { projectId, country, dateFrom, dateTo },
                          { campaign: campaignFilter || undefined }
                        ),
                        label:
                          section.drill_to === 'targets'
                            ? '投放'
                            : section.drill_to === 'campaigns'
                              ? '活动'
                              : '流量',
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </WarmPanel>
      </WarmDeferredSection>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="traffic-quality-deferred-table">
        <WarmPanel title="活动层分析" bodyClassName="p-0">
          <div className="w-full min-w-0">
            {/* 桌面端：完整表格 */}
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>活动</WarmHead>
                  <WarmHead>风险等级</WarmHead>
                  <WarmHead numeric>总曝光 / 无效曝光</WarmHead>
                  <WarmHead numeric>无效曝光率</WarmHead>
                  <WarmHead numeric>总点击 / 无效点击</WarmHead>
                  <WarmHead numeric>无效点击率</WarmHead>
                  <WarmHead>下一步</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {data.items.map((item) => (
                  <WarmRow key={item.campaign_name}>
                    <WarmCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                          {item.campaign_name}
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {item.status}
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill
                        tone={
                          item.risk_level === '高风险'
                            ? 'neg'
                            : item.risk_level === '中风险'
                              ? 'warn'
                              : 'muted'
                        }
                      >
                        <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                        {item.risk_level}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell>
                      <WarmNumber>
                        {item.total_impressions} / {item.invalid_impressions}
                      </WarmNumber>
                    </WarmCell>
                    <WarmCell numeric>{(item.invalid_impression_rate * 100).toFixed(2)}%</WarmCell>
                    <WarmCell>
                      <WarmNumber>
                        {item.total_clicks} / {item.invalid_clicks}
                      </WarmNumber>
                    </WarmCell>
                    <WarmCell numeric>{(item.invalid_click_rate * 100).toFixed(2)}%</WarmCell>
                    <WarmCell className="max-w-[220px] text-sm text-[var(--warm-ledger-color-text-muted)]">
                      {item.next_step}
                    </WarmCell>
                    <WarmCell className="align-top">
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '投放',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'placements',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '广告位',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '搜索词',
                          },
                        ]}
                      />
                    </WarmCell>
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
