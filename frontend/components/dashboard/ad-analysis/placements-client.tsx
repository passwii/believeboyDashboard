'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Gauge } from 'lucide-react'

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
  WarmDeferredSection,
} from './warm-analysis'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'

type PlacementItem = {
  campaign_name: string
  placement: string
  impressions: number
  clicks: number
  ctr: number
  cpc: number
  spend: number
  sales_7d: number
  orders_7d: number
  units_7d: number
  cvr_7d: number
  acos: number
  roas: number
  action: string
  next_step: string
}

type PlacementSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type PlacementResponse = {
  project_id: number
  country: string
  summary_cards: PlacementSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: PlacementItem[]
}

export function AdAnalysisPlacementsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const placementFilter = searchParams.get('placement') || ''
  const skuFilter = searchParams.get('sku') || ''

  const [dataResult, setDataResult] = useState<{
    signature: string
    value: PlacementResponse
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
    placementFilter,
    skuFilter,
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
        if (placementFilter) query.set('placement', placementFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<PlacementResponse>('placements', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '广告位分析加载失败',
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
    placementFilter,
    projectId,
    querySignature,
    session,
    skuFilter,
    status,
    refreshKey,
  ])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载广告位分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有广告位明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有广告位明细。" />
      </>
    )
  }

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = placementFilter
    ? data.items.filter((item) =>
        item.placement.toLowerCase().includes(placementFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState
          rowHeight="lg"
          message={`当前筛选下没有匹配“${placementFilter}”的广告位。`}
        />
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="placements">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(placementFilter ? [{ label: '当前广告位', value: placementFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* 桌面端汇总卡固定四列，金额由 Warm 数字字体完整展示 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.summary_cards.map((card) => (
          <WarmKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <WarmDeferredSection fallbackHeight="h-[280px]" data-testid="placements-deferred-narrative">
        <WarmPanel title="广告位层分析" bodyClassName="p-2">
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
                          {
                            campaign: campaignFilter || undefined,
                            placement: placementFilter || undefined,
                            sku: skuFilter || undefined,
                          }
                        ),
                        label: section.drill_to === 'campaigns' ? '活动' : '广告位',
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </WarmPanel>
      </WarmDeferredSection>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="placements-deferred-table">
        <WarmPanel title="活动层分析" bodyClassName="p-0">
          <div className="w-full min-w-0">
            {/* 桌面端：完整表格 */}
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>广告位</WarmHead>
                  <WarmHead>活动</WarmHead>
                  <WarmHead>建议</WarmHead>
                  <WarmHead numeric>Spend</WarmHead>
                  <WarmHead numeric>Sales</WarmHead>
                  <WarmHead numeric>Orders</WarmHead>
                  <WarmHead>下一步</WarmHead>
                  <WarmHead numeric>ACOS</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {filteredItems.map((item) => (
                  <WarmRow key={`${item.campaign_name}-${item.placement}`}>
                    <WarmCell className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                      {item.placement}
                    </WarmCell>
                    <WarmCell>{item.campaign_name}</WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted">
                        <Gauge className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell numeric>${item.spend.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.sales_7d.toFixed(2)}</WarmCell>
                    <WarmCell numeric>{item.orders_7d}</WarmCell>
                    <WarmCell className="max-w-[220px] text-sm text-[var(--warm-ledger-color-text-muted)]">
                      {item.next_step}
                    </WarmCell>
                    <WarmCell numeric>{(item.acos * 100).toFixed(2)}%</WarmCell>
                    <WarmCell>
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              {
                                campaign: item.campaign_name,
                                sku: skuFilter || undefined,
                                placement: item.placement,
                              }
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'placements',
                              { projectId, country, dateFrom, dateTo },
                              {
                                campaign: item.campaign_name,
                                sku: skuFilter || undefined,
                                placement: item.placement,
                              }
                            ),
                            label: '聚焦',
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
