'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import {
  WarmErrorBar,
  WarmEmptyState,
  WarmPanel,
  WarmKpiTile,
  WarmPill,
  WarmTable,
  WarmBody,
  WarmCell,
  WarmHead,
  WarmTHead,
  WarmRow,
  WarmRefreshStatus,
  WarmNumber,
  WarmDeferredSection,
} from './warm-analysis'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'

type CampaignItem = {
  campaign_name: string
  status: string
  targeting_type: string
  bidding_strategy: string
  budget: number
  impressions: number
  clicks: number
  ctr: number
  cpc: number
  spend: number
  sales_7d: number
  orders_7d: number
  acos: number
  roas: number
  grade: string
  budget_gap: number
  budget_utilization_rate: number
  missed_sales_max: number
  cross_sell_orders_7d: number
  cross_sell_sales_7d: number
  cross_sell_action: string
  next_action: string
}

type CampaignSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type CampaignResponse = {
  project_id: number
  country: string
  summary_cards: CampaignSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: CampaignItem[]
}

export function AdAnalysisCampaignsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const skuFilter = searchParams.get('sku') || ''
  const searchTermFilter = searchParams.get('searchTerm') || ''
  const placementFilter = searchParams.get('placement') || ''

  const [dataResult, setDataResult] = useState<{
    signature: string
    value: CampaignResponse
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
    skuFilter,
    searchTermFilter,
    placementFilter,
    sessionUser?.id ?? null,
    sessionUser?.roleType ?? null,
    sessionUser?.name ?? null,
  ])
  // A refreshKey change keeps the same signature and therefore the last good payload;
  // query changes immediately stop rendering results from the previous scope.
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
        if (skuFilter) query.set('sku', skuFilter)
        if (searchTermFilter) query.set('search_term', searchTermFilter)
        if (placementFilter) query.set('placement', placementFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<CampaignResponse>('campaigns', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '活动分析加载失败',
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
    searchTermFilter,
    session,
    skuFilter,
    status,
    refreshKey,
  ])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载活动分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有广告活动明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={isLoading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有广告活动明细。" />
      </>
    )
  }

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = campaignFilter
    ? data.items.filter((item) =>
        item.campaign_name.toLowerCase().includes(campaignFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={isLoading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message={`当前筛选下没有匹配“${campaignFilter}”的活动。`} />
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="campaigns">
      <WarmRefreshStatus loading={isLoading} error={error} hasData />
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(searchTermFilter ? [{ label: '当前搜索词', value: searchTermFilter }] : []),
          ...(placementFilter ? [{ label: '当前广告位', value: placementFilter }] : []),
        ]}
      />
      {/* 桌面端汇总卡固定四列，金额由 Warm 数字字体完整展示 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="campaign-summary-cards">
        {data.summary_cards.map((card) => (
          <div key={card.label} data-testid="campaign-summary-card">
            <WarmKpiTile label={card.label} value={card.value} />
          </div>
        ))}
      </div>

      <WarmDeferredSection fallbackHeight="h-[280px]" data-testid="campaigns-deferred-narrative">
        <WarmPanel title="活动层分析" bodyClassName="p-2">
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
                            sku: skuFilter || undefined,
                            searchTerm: searchTermFilter || undefined,
                            placement: placementFilter || undefined,
                          }
                        ),
                        label:
                          section.drill_to === 'budget'
                            ? '预算'
                            : section.drill_to === 'products'
                              ? 'SKU'
                              : '活动',
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </WarmPanel>
      </WarmDeferredSection>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="campaigns-deferred-table">
        <WarmPanel title="活动分级" bodyClassName="p-0">
          {/* 桌面端：完整表格 */}
          <div>
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>活动</WarmHead>
                  <WarmHead>Grade</WarmHead>
                  <WarmHead>类型</WarmHead>
                  <WarmHead numeric>Spend</WarmHead>
                  <WarmHead numeric>Sales</WarmHead>
                  <WarmHead numeric>预算缺口</WarmHead>
                  <WarmHead numeric>关联销售</WarmHead>
                  <WarmHead>下一步</WarmHead>
                  <WarmHead numeric>ACOS</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {filteredItems.map((item) => (
                  <WarmRow key={item.campaign_name}>
                    <WarmCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                          {item.campaign_name}
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {item.status} / {item.bidding_strategy}
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          CTR {(item.ctr * 100).toFixed(2)}% / 预算在线{' '}
                          {(item.budget_utilization_rate * 100).toFixed(2)}%
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted">{item.grade}</WarmPill>
                    </WarmCell>
                    <WarmCell>{item.targeting_type}</WarmCell>
                    <WarmCell numeric>${item.spend.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.sales_7d.toFixed(2)}</WarmCell>
                    <WarmCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p>
                          <WarmNumber>${item.budget_gap.toFixed(2)}</WarmNumber>
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          错失销售 <WarmNumber>${item.missed_sales_max.toFixed(2)}</WarmNumber>
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p>
                          <WarmNumber>${item.cross_sell_sales_7d.toFixed(2)}</WarmNumber>
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          <WarmNumber>{item.cross_sell_orders_7d}</WarmNumber> 单
                        </p>
                        <WarmPill tone="muted">{item.cross_sell_action}</WarmPill>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted">{item.next_action}</WarmPill>
                    </WarmCell>
                    <WarmCell numeric>{(item.acos * 100).toFixed(2)}%</WarmCell>
                    <WarmCell className="align-top">
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'budget',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '预算',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'products',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: 'SKU',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '搜索词',
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
                              'traffic-quality',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '流量',
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
