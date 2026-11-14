'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { TrendingUp } from 'lucide-react'

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

type SearchTermItem = {
  search_term: string
  match_type: string
  campaign_count: number
  primary_campaign: string
  impressions: number
  clicks: number
  ctr: number
  cpc: number
  spend: number
  sales_7d: number
  orders_7d: number
  cvr_7d: number
  acos: number
  impression_share: number
  impression_rank: number
  action: string
}

type SearchTermSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type SearchTermsResponse = {
  project_id: number
  country: string
  summary_cards: SearchTermSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: SearchTermItem[]
}

export function AdAnalysisSearchTermsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const searchTermFilter = searchParams.get('searchTerm') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const skuFilter = searchParams.get('sku') || ''

  const [dataResult, setDataResult] = useState<{
    signature: string
    value: SearchTermsResponse
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
    searchTermFilter,
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
        if (searchTermFilter) query.set('search_term', searchTermFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<SearchTermsResponse>(
          'search-terms',
          query,
          session
        )
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '搜索词分析加载失败',
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
    searchTermFilter,
    session,
    skuFilter,
    status,
    refreshKey,
  ])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载搜索词分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有搜索词明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有搜索词明细。" />
      </>
    )
  }

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = searchTermFilter
    ? data.items.filter((item) =>
        item.search_term.toLowerCase().includes(searchTermFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState
          rowHeight="lg"
          message={`当前筛选下没有匹配“${searchTermFilter}”的搜索词。`}
        />
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="search-terms">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(searchTermFilter ? [{ label: '当前搜索词', value: searchTermFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* 桌面端汇总卡固定四列，金额由 Warm 数字字体完整展示 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.summary_cards.map((card) => (
          <WarmKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <WarmDeferredSection fallbackHeight="h-[280px]" data-testid="search-terms-deferred-narrative">
        <WarmPanel title="搜索词层分析" bodyClassName="p-2">
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
                            searchTerm: searchTermFilter || undefined,
                            sku: skuFilter || undefined,
                          }
                        ),
                        label: section.drill_to === 'products' ? 'SKU' : '搜索词',
                      },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </WarmPanel>
      </WarmDeferredSection>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="search-terms-deferred-table">
        <WarmPanel title="活动层分析" bodyClassName="p-0">
          <div className="w-full min-w-0">
            {/* 桌面端：完整表格 */}
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>搜索词</WarmHead>
                  <WarmHead>动作</WarmHead>
                  <WarmHead numeric>份额 / 排名</WarmHead>
                  <WarmHead numeric>Spend</WarmHead>
                  <WarmHead numeric>Sales</WarmHead>
                  <WarmHead numeric>Orders</WarmHead>
                  <WarmHead numeric>CTR</WarmHead>
                  <WarmHead numeric>CVR</WarmHead>
                  <WarmHead numeric>ACOS</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {filteredItems.map((item) => (
                  <WarmRow key={`${item.search_term}-${item.match_type}`}>
                    <WarmCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                          {item.search_term}
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {item.match_type} / {item.campaign_count} 个活动
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted">
                        <TrendingUp className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell>
                      <WarmNumber>
                        {(item.impression_share * 100).toFixed(2)}% / {item.impression_rank || '-'}
                      </WarmNumber>
                    </WarmCell>
                    <WarmCell numeric>${item.spend.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.sales_7d.toFixed(2)}</WarmCell>
                    <WarmCell numeric>{item.orders_7d}</WarmCell>
                    <WarmCell numeric>{(item.ctr * 100).toFixed(2)}%</WarmCell>
                    <WarmCell numeric>{(item.cvr_7d * 100).toFixed(2)}%</WarmCell>
                    <WarmCell numeric>{(item.acos * 100).toFixed(2)}%</WarmCell>
                    <WarmCell className="align-top">
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign }
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign }
                            ),
                            label: '投放',
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
