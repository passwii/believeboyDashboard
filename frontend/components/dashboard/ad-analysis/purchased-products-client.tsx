'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Boxes, ShoppingBasket } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import {
  WarmErrorBar,
  WarmEmptyState,
  WarmPanel,
  WarmPill,
  WarmRefreshStatus,
  WarmTable,
  WarmBody,
  WarmCell,
  WarmHead,
  WarmTHead,
  WarmRow,
  WarmNumber,
} from './warm-analysis'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'

type PurchasedProductItem = {
  purchased_asin: string
  ad_sku: string
  campaign_count: number
  other_sku_units_7d: number
  other_sku_orders_7d: number
  other_sku_sales_7d: number
  action: string
}

type PurchasedProductsResponse = {
  project_id: number
  country: string
  items: PurchasedProductItem[]
}


export function AdAnalysisPurchasedProductsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const skuFilter = searchParams.get('sku') || ''
  const purchasedAsinFilter = searchParams.get('purchasedAsin') || ''
  const campaignFilter = searchParams.get('campaign') || ''

  const [dataResult, setDataResult] = useState<{ signature: string; value: PurchasedProductsResponse } | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(null)
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId, country, dateFrom, dateTo, campaignFilter, skuFilter, purchasedAsinFilter,
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
        if (purchasedAsinFilter) query.set('purchased_asin', purchasedAsinFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<PurchasedProductsResponse>('purchased-products', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '已购买商品分析加载失败',
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
  }, [campaignFilter, country, dateFrom, dateTo, projectId, querySignature, purchasedAsinFilter, session, skuFilter, status, refreshKey])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载已购买商品分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有已购买商品明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有已购买商品明细。" />
      </>
    )
  }

  const filteredItems = data.items.filter((item) => {
    const matchesSku = skuFilter
      ? item.ad_sku.toLowerCase().includes(skuFilter.toLowerCase())
      : true
    const matchesPurchasedAsin = purchasedAsinFilter
      ? item.purchased_asin.toLowerCase().includes(purchasedAsinFilter.toLowerCase())
      : true
    return matchesSku && matchesPurchasedAsin
  })

  if (filteredItems.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前筛选下没有匹配的关联购买明细。" />
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="purchased-products">
      <WarmRefreshStatus loading={loading} error={error} hasData />
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(purchasedAsinFilter ? [{ label: '当前关联 ASIN', value: purchasedAsinFilter }] : []),
        ]}
      />

      <WarmPanel title="活动层分析" bodyClassName="p-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
            <ShoppingBasket className="h-4 w-4 text-[var(--warm-ledger-color-accent-strong)]" />
          {/* 桌面端：完整表格 */}
          <div>
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>关联 ASIN</WarmHead>
                  <WarmHead>动作</WarmHead>
                  <WarmHead>广告 SKU</WarmHead>
                  <WarmHead numeric>活动数</WarmHead>
                  <WarmHead numeric>Units</WarmHead>
                  <WarmHead numeric>Orders</WarmHead>
                  <WarmHead numeric>Sales</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {filteredItems.map((item) => (
                  <WarmRow key={`${item.purchased_asin}-${item.ad_sku}`}>
                    <WarmCell className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]"><WarmNumber>{item.purchased_asin}</WarmNumber></WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted"><Boxes className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell><WarmNumber>{item.ad_sku}</WarmNumber></WarmCell>
                    <WarmCell numeric>{item.campaign_count}</WarmCell>
                    <WarmCell numeric>{item.other_sku_units_7d}</WarmCell>
                    <WarmCell numeric>{item.other_sku_orders_7d}</WarmCell>
                    <WarmCell numeric>${item.other_sku_sales_7d.toFixed(2)}</WarmCell>
                  </WarmRow>
                ))}
              </WarmBody>
            </WarmTable>
          </div>

        </div>
      </WarmPanel>
    </div>
  )
}
