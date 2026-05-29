'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search, TrendingUp } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const API_BASE = '/api/backend'

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

async function parseError(response: Response): Promise<string> {
  const raw = await response.text()
  try {
    const payload = JSON.parse(raw) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return raw || `请求失败 (${response.status})`
  }
}

export function AdAnalysisSearchTermsClient() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const searchTermFilter = searchParams.get('searchTerm') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const skuFilter = searchParams.get('sku') || ''

  const [data, setData] = useState<SearchTermsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
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
        if (searchTermFilter) query.set('search_term', searchTermFilter)
        if (skuFilter) query.set('sku', skuFilter)
        const response = await fetch(
          `${API_BASE}/api/v1/ad-analysis/search-terms?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as SearchTermsResponse
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '搜索词分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, searchTermFilter, skuFilter])

  if (!projectId) return <EmptyState rowHeight='lg' message='请先选择项目。' />
  if (loading) return <EmptyState rowHeight='lg' message='正在加载搜索词分析...' />
  if (error) {
    return (
      <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0) return <EmptyState rowHeight='lg' message='当前没有搜索词明细。' />

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = searchTermFilter
    ? data.items.filter((item) => item.search_term.toLowerCase().includes(searchTermFilter.toLowerCase()))
    : data.items

  if (filteredItems.length === 0) {
    return <EmptyState rowHeight='lg' message={`当前筛选下没有匹配“${searchTermFilter}”的搜索词。`} />
  }

  return (
    <div className='space-y-5'>
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(searchTermFilter ? [{ label: '当前搜索词', value: searchTermFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
        {data.summary_cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className='pb-2'>
              <CardTitle className='text-base'>{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className='text-2xl font-semibold'>{card.value}</p>
              <p className='mt-1 text-sm text-muted-foreground'>{card.helper || '-'}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>搜索词层分析</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          {narrativeSections.map((section) => (
            <div
              key={section.title}
              className='rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
            >
              <p className='font-medium'>{section.title}</p>
              <p className='mt-1 text-sm leading-6 text-foreground/90'>{section.summary}</p>
              <div className='mt-2 space-y-1 text-sm text-muted-foreground'>
                {section.evidence.map((evidence) => (
                  <p key={evidence}>- {evidence}</p>
                ))}
              </div>
              {section.action ? (
                <p className='mt-2 text-sm leading-6 text-foreground/80'>动作：{section.action}</p>
              ) : null}
              <div className='mt-3'>
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
                        },
                      ),
                      label: section.drill_to === 'products' ? 'SKU' : '搜索词',
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <Search className='h-4 w-4 text-primary' />
            <CardTitle className='text-lg'>搜索词扩量与否词</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>搜索词</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>份额 / 排名</TableHead>
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
                {filteredItems.map((item) => (
                  <TableRow key={`${item.search_term}-${item.match_type}`}>
                    <TableCell className='align-top'>
                      <div className='space-y-1'>
                        <p className='font-medium'>{item.search_term}</p>
                        <p className='text-xs text-muted-foreground'>
                          {item.match_type} / {item.campaign_count} 个活动
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant='secondary'>
                        <TrendingUp className='mr-1 h-3.5 w-3.5' />
                        {item.action}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {(item.impression_share * 100).toFixed(2)}% / {item.impression_rank || '-'}
                    </TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.sales_7d.toFixed(2)}</TableCell>
                    <TableCell>{item.orders_7d}</TableCell>
                    <TableCell>{(item.ctr * 100).toFixed(2)}%</TableCell>
                    <TableCell>{(item.cvr_7d * 100).toFixed(2)}%</TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell className='align-top'>
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign },
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign },
                            ),
                            label: '投放',
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
          <div className='lg:hidden space-y-3'>
            {filteredItems.map((item) => (
              <div key={`${item.search_term}-${item.match_type}`} className='dashboard-surface p-4 space-y-3'>
                <div className='flex items-start justify-between gap-2 border-b border-border/70 pb-3'>
                  <div className='min-w-0 flex-1'>
                    <p className='font-medium text-sm'>{item.search_term}</p>
                    <p className='text-xs text-muted-foreground'>
                      {item.match_type} / {item.campaign_count} 个活动
                    </p>
                  </div>
                  <Badge variant='secondary' className='shrink-0'>
                    <TrendingUp className='mr-1 h-3 w-3' />
                    {item.action}
                  </Badge>
                </div>

                <div className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
                  <div>
                    <span className='text-xs text-muted-foreground'>Spend</span>
                    <div className='font-medium'>${item.spend.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>Sales</span>
                    <div className='font-medium'>${item.sales_7d.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>Orders</span>
                    <div className='font-medium'>{item.orders_7d}</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>ACOS</span>
                    <div className={cn("font-medium", item.acos > 0.3 ? 'text-red-500' : 'text-emerald-500')}>
                      {(item.acos * 100).toFixed(2)}%
                    </div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>CTR</span>
                    <div className='font-medium'>{(item.ctr * 100).toFixed(2)}%</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>CVR</span>
                    <div className='font-medium'>{(item.cvr_7d * 100).toFixed(2)}%</div>
                  </div>
                </div>

                <div className='text-xs text-muted-foreground'>
                  份额: {(item.impression_share * 100).toFixed(2)}% / 排名: {item.impression_rank || '-'}
                </div>

                <div className='flex gap-2 pt-2 border-t border-border/70'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-8 min-h-[44px] text-xs flex-1'
                    onClick={() => {
                      const href = buildAnalysisDrillHref('campaigns', { projectId, country, dateFrom, dateTo }, { campaign: item.primary_campaign })
                      if (href) window.location.href = href
                    }}
                  >
                    活动
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-8 min-h-[44px] text-xs flex-1'
                    onClick={() => {
                      const href = buildAnalysisDrillHref('targets', { projectId, country, dateFrom, dateTo }, { campaign: item.primary_campaign })
                      if (href) window.location.href = href
                    }}
                  >
                    投放
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
