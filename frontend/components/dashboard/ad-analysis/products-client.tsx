'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Target } from 'lucide-react'

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

type ProductItem = {
  ad_sku: string
  ad_asin: string
  campaign_count: number
  primary_campaign: string
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
  grade: string
  cross_sell_asin_count: number
  cross_sell_orders_7d: number
  cross_sell_sales_7d: number
  top_purchased_asin: string
  cross_sell_action: string
  next_action: string
}

type ProductSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type ProductResponse = {
  project_id: number
  country: string
  summary_cards: ProductSummaryCard[]
  items: ProductItem[]
}


export function AdAnalysisProductsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const skuFilter = searchParams.get('sku') || ''
  const campaignFilter = searchParams.get('campaign') || ''

  const [dataResult, setDataResult] = useState<{ signature: string; value: ProductResponse } | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(null)
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId, country, dateFrom, dateTo, campaignFilter, skuFilter,
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
        if (campaignFilter) query.set('campaign', campaignFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<ProductResponse>('products', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : 'SKU 分析加载失败',
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
  }, [campaignFilter, country, dateFrom, dateTo, projectId, querySignature, session, skuFilter, status, refreshKey])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载 SKU 分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有推广商品明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有推广商品明细。" />
      </>
    )
  }

  const filteredItems = skuFilter
    ? data.items.filter((item) => item.ad_sku.toLowerCase().includes(skuFilter.toLowerCase()))
    : data.items

  if (filteredItems.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message={`当前筛选下没有匹配“${skuFilter}”的 SKU。`} />
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="products">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* 桌面端汇总卡固定四列，金额由 Warm 数字字体完整展示 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.summary_cards.map((card) => (
          <WarmKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="products-deferred-table">
      <WarmPanel title="活动层分析" bodyClassName="p-0">
          <div className="w-full min-w-0">
          {/* 桌面端：完整表格 */}
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>SKU</WarmHead>
                  <WarmHead>Grade</WarmHead>
                  <WarmHead numeric>Spend</WarmHead>
                  <WarmHead numeric>Sales</WarmHead>
                  <WarmHead numeric>Orders</WarmHead>
                  <WarmHead numeric>ACOS</WarmHead>
                  <WarmHead numeric>关联销售</WarmHead>
                  <WarmHead>动作</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {filteredItems.map((item) => (
                  <WarmRow key={`${item.ad_sku}-${item.ad_asin}`}>
                    <WarmCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]"><WarmNumber>{item.ad_sku}</WarmNumber></p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          <WarmNumber>{item.ad_asin}</WarmNumber> / <WarmNumber>{item.campaign_count}</WarmNumber> 个活动
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          CTR {(item.ctr * 100).toFixed(2)}% / CVR {(item.cvr_7d * 100).toFixed(2)}%
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted"><Target className="mr-1 h-3.5 w-3.5" />
                        {item.grade}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell numeric>${item.spend.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.sales_7d.toFixed(2)}</WarmCell>
                    <WarmCell numeric>{item.orders_7d}</WarmCell>
                    <WarmCell numeric>{(item.acos * 100).toFixed(2)}%</WarmCell>
                    <WarmCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p><WarmNumber>${item.cross_sell_sales_7d.toFixed(2)}</WarmNumber></p>
                        <p className="text-[var(--warm-ledger-color-text-muted)]">
                          <WarmNumber>{item.cross_sell_orders_7d}</WarmNumber> 单 / <WarmNumber>{item.cross_sell_asin_count}</WarmNumber> 个 ASIN
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          Top ASIN: <WarmNumber>{item.top_purchased_asin}</WarmNumber>
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <div className="space-y-1">
                        <WarmPill tone="muted">{item.cross_sell_action}</WarmPill>
                        <p className="max-w-[220px] text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {item.next_action}
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell className="align-top">
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign, sku: item.ad_sku }
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign, sku: item.ad_sku }
                            ),
                            label: '搜索词',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign, sku: item.ad_sku }
                            ),
                            label: '投放',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'placements',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign, sku: item.ad_sku }
                            ),
                            label: '广告位',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'purchased-products',
                              { projectId, country, dateFrom, dateTo },
                              {
                                campaign: item.primary_campaign,
                                sku: item.ad_sku,
                                purchasedAsin:
                                  item.top_purchased_asin !== '-'
                                    ? item.top_purchased_asin
                                    : undefined,
                              }
                            ),
                            label: '关联购买',
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
