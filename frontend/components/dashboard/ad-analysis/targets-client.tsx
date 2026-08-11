'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Crosshair, SlidersHorizontal } from 'lucide-react'

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


type TargetItem = {
  target_text: string
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
  top_of_search_impression_share: number
  action: string
}

type TargetSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type TargetsResponse = {
  project_id: number
  country: string
  summary_cards: TargetSummaryCard[]
  items: TargetItem[]
}


export function AdAnalysisTargetsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const skuFilter = searchParams.get('sku') || ''
  const targetTextFilter = searchParams.get('targetText') || ''

  const [data, setData] = useState<TargetsResponse | null>(null)
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
        if (targetTextFilter) query.set('target_text', targetTextFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<TargetsResponse>('targets', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '投放分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, session, skuFilter, status, targetTextFilter])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载投放分析..." />
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有投放明细。" />

  return (
    <div className="space-y-5">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(targetTextFilter ? [{ label: '当前投放', value: targetTextFilter }] : []),
        ]}
      />
      {/* BLF-611：手机端汇总卡一行两个（总则 1）；数字降级防挤压；md+ 行为不变 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
        {data.summary_cards.map((card) => (
          <Card key={card.label} className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold sm:text-2xl">{card.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{card.helper || '-'}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="targets-deferred-table">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-primary" />
            <CardTitle className="text-lg">投放入口效率</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>投放</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>首页份额</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Sales</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>CTR</TableHead>
                  <TableHead>CVR</TableHead>
                  <TableHead>ACOS</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={`${item.target_text}-${item.match_type}`}>
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-medium">{item.target_text}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.match_type} / {item.campaign_count} 个活动
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </Badge>
                    </TableCell>
                    <TableCell>{(item.top_of_search_impression_share * 100).toFixed(2)}%</TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.sales_7d.toFixed(2)}</TableCell>
                    <TableCell>{item.orders_7d}</TableCell>
                    <TableCell>{(item.ctr * 100).toFixed(2)}%</TableCell>
                    <TableCell>{(item.cvr_7d * 100).toFixed(2)}%</TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell className="align-top">
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
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign }
                            ),
                            label: '搜索词',
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
            {data.items.map((item) => (
              <div
                key={`${item.target_text}-${item.match_type}`}
                className="dashboard-surface p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2 border-b border-border/70 pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.target_text}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.match_type} / {item.campaign_count} 个活动
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    <SlidersHorizontal className="mr-1 h-3 w-3" />
                    {item.action}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">首页份额</span>
                    <div className="font-medium">
                      {(item.top_of_search_impression_share * 100).toFixed(2)}%
                    </div>
                  </div>
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
                    <span className="text-xs text-muted-foreground">CTR</span>
                    <div className="font-medium">{(item.ctr * 100).toFixed(2)}%</div>
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

                <div className="flex gap-2 pt-2 border-t border-border/70">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs flex-1"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'campaigns',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.primary_campaign }
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
                        { campaign: item.primary_campaign }
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
