'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Package2, Target } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

  const [data, setData] = useState<ProductResponse | null>(null)
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
        if (campaignFilter) query.set('campaign', campaignFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<ProductResponse>('products', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : 'SKU 分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, session, skuFilter, status])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载 SKU 分析..." />
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有推广商品明细。" />

  const filteredItems = skuFilter
    ? data.items.filter((item) => item.ad_sku.toLowerCase().includes(skuFilter.toLowerCase()))
    : data.items

  if (filteredItems.length === 0) {
    return <EmptyState rowHeight="lg" message={`当前筛选下没有匹配“${skuFilter}”的 SKU。`} />
  }

  return (
    <div className="space-y-5">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.summary_cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{card.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{card.helper || '-'}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="products-deferred-table">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package2 className="h-4 w-4 text-primary" />
            <CardTitle className="text-lg">SKU 承接表现</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Sales</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>ACOS</TableHead>
                  <TableHead>关联销售</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={`${item.ad_sku}-${item.ad_asin}`}>
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-medium">{item.ad_sku}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.ad_asin} / {item.campaign_count} 个活动
                        </p>
                        <p className="text-xs text-muted-foreground">
                          CTR {(item.ctr * 100).toFixed(2)}% / CVR {(item.cvr_7d * 100).toFixed(2)}%
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        <Target className="mr-1 h-3.5 w-3.5" />
                        {item.grade}
                      </Badge>
                    </TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.sales_7d.toFixed(2)}</TableCell>
                    <TableCell>{item.orders_7d}</TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p>${item.cross_sell_sales_7d.toFixed(2)}</p>
                        <p className="text-muted-foreground">
                          {item.cross_sell_orders_7d} 单 / {item.cross_sell_asin_count} 个 ASIN
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Top ASIN: {item.top_purchased_asin}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant="outline">{item.cross_sell_action}</Badge>
                        <p className="max-w-[220px] text-xs text-muted-foreground">
                          {item.next_action}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* 手机端：卡片列表 */}
          <div className="lg:hidden space-y-3">
            {filteredItems.map((item) => (
              <div
                key={`${item.ad_sku}-${item.ad_asin}`}
                className="dashboard-surface p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2 border-b border-border/70 pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.ad_sku}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.ad_asin}</p>
                    <p className="text-xs text-muted-foreground">
                      CTR {(item.ctr * 100).toFixed(2)}% / CVR {(item.cvr_7d * 100).toFixed(2)}%
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    <Target className="mr-1 h-3 w-3" />
                    {item.grade}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">Spend</span>
                    <div className="font-medium">${item.spend.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Sales</span>
                    <div className="font-medium">${item.sales_7d.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Orders</span>
                    <div className="font-medium">{item.orders_7d}</div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">ACOS</span>
                    <div
                      className={cn(
                        'font-medium',
                        item.acos > 0.3 ? 'text-red-500' : 'text-emerald-500'
                      )}
                    >
                      {(item.acos * 100).toFixed(2)}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div>
                    <span className="text-muted-foreground">关联销售</span>
                    <div className="font-medium">${item.cross_sell_sales_7d.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">关联单数</span>
                    <div className="font-medium">{item.cross_sell_orders_7d} 单</div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-border/70">
                  <Badge variant="outline" className="text-xs">
                    {item.cross_sell_action}
                  </Badge>
                  <p className="text-xs text-muted-foreground w-full">{item.next_action}</p>
                </div>

                <div className="flex gap-2 pt-2 border-t border-border/70">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs flex-1"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'campaigns',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.primary_campaign, sku: item.ad_sku }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    活动
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs flex-1"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'search-terms',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.primary_campaign, sku: item.ad_sku }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    搜索词
                  </Button>
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
