'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, BarChart3, Boxes, Radar, Search, TimerReset, TrendingUp } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import {
  buildAnalysisDrillHref,
  getAnalysisDrillLabel,
} from '@/components/dashboard/ad-analysis/drill'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const API_BASE = '/api/backend'
type OverviewMetric = {
  label: string
  value: number
  display_value: string
  helper: string | null
}

type OverviewIssue = {
  title: string
  level: string
  summary: string
  drill_to?: string | null
  next_step?: string | null
}

type OverviewResponse = {
  project_id: number
  country: string
  metrics: OverviewMetric[]
  issue_cards: OverviewIssue[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  comparison?: {
    current_start?: string | null
    current_end?: string | null
    previous_start?: string | null
    previous_end?: string | null
    spend_change_ratio?: number | null
    clicks_change_ratio?: number | null
    sales_change_ratio?: number | null
    orders_change_ratio?: number | null
    cpc_change_ratio?: number | null
    acos_change_ratio?: number | null
    summary?: string | null
  } | null
  top_campaigns: Array<Record<string, unknown>>
  top_products: Array<Record<string, unknown>>
  top_waste_terms: Array<Record<string, unknown>>
  trend_summary: Array<Record<string, unknown>>
  top_cross_sell_products: Array<Record<string, unknown>>
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

export function AdAnalysisOverviewClient() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''

  const [data, setData] = useState<OverviewResponse | null>(null)
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
        const response = await fetch(
          `${API_BASE}/api/v1/ad-analysis/overview?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as OverviewResponse
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : '广告总览加载失败')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [country, dateFrom, dateTo, projectId])

  if (!projectId) {
    return <EmptyState rowHeight='lg' message='请先在顶部筛选区选择项目。' />
  }

  if (loading) {
    return <EmptyState rowHeight='lg' message='正在加载广告总览...' />
  }

  if (error) {
    return (
      <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
        {error}
      </div>
    )
  }

  if (!data) {
    return <EmptyState rowHeight='lg' message='当前还没有可展示的广告总览数据。' />
  }

  const narrativeSections = data.narrative_sections ?? []
  const comparison = data.comparison

  const buildDrillHref = (drillTo?: string | null) => {
    return buildAnalysisDrillHref(
      drillTo || '',
      { projectId, country, dateFrom, dateTo },
    )
  }

  const buildDrillLabel = (drillTo?: string | null) => {
    return getAnalysisDrillLabel(drillTo) || ''
  }

  return (
    <div className='space-y-5'>
      <div className='grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4'>
        {data.metrics.map((metric) => (
          <Card key={metric.label} className='hover-lift'>
            <CardHeader className='pb-2'>
              <CardDescription>{metric.label}</CardDescription>
              <CardTitle className='text-2xl'>{metric.display_value}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className='text-sm text-muted-foreground'>{metric.helper || '-'}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {comparison ? (
        <Card>
          <CardHeader className='pb-3'>
            <CardTitle className='text-lg'>周期对比</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3 pt-0'>
            <p className='text-sm text-muted-foreground'>
              当前周期 {comparison.current_start} ~ {comparison.current_end}
              {' '}对比上一周期 {comparison.previous_start} ~ {comparison.previous_end}
            </p>
            {comparison.summary ? <p className='text-sm leading-6 text-foreground/90'>{comparison.summary}</p> : null}
            <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
              <div className='rounded-lg border border-border/70 px-3 py-3 text-sm'>
                <p className='text-muted-foreground'>花费变化</p>
                <p className='mt-1 font-medium'>
                  {comparison.spend_change_ratio != null ? `${(comparison.spend_change_ratio * 100).toFixed(2)}%` : '-'}
                </p>
              </div>
              <div className='rounded-lg border border-border/70 px-3 py-3 text-sm'>
                <p className='text-muted-foreground'>点击变化</p>
                <p className='mt-1 font-medium'>
                  {comparison.clicks_change_ratio != null ? `${(comparison.clicks_change_ratio * 100).toFixed(2)}%` : '-'}
                </p>
              </div>
              <div className='rounded-lg border border-border/70 px-3 py-3 text-sm'>
                <p className='text-muted-foreground'>销售变化</p>
                <p className='mt-1 font-medium'>
                  {comparison.sales_change_ratio != null ? `${(comparison.sales_change_ratio * 100).toFixed(2)}%` : '-'}
                </p>
              </div>
              <div className='rounded-lg border border-border/70 px-3 py-3 text-sm'>
                <p className='text-muted-foreground'>CPC 变化</p>
                <p className='mt-1 font-medium'>
                  {comparison.cpc_change_ratio != null ? `${(comparison.cpc_change_ratio * 100).toFixed(2)}%` : '-'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className='grid items-start gap-5 xl:grid-cols-3'>
        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <BarChart3 className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>结构化分析</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='space-y-3 pt-0'>
            {narrativeSections.length === 0 ? (
              <EmptyState rowHeight='md' message='当前还没有可用的结构化分析结论。' />
            ) : (
              narrativeSections.map((section) => (
                <div
                  key={section.title}
                  className='rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                >
                  <div className='mb-2 flex items-center gap-2'>
                    <p className='font-medium'>{section.title}</p>
                    {buildDrillLabel(section.drill_to) ? (
                      <Badge variant='secondary'>{buildDrillLabel(section.drill_to)}</Badge>
                    ) : null}
                  </div>
                  <p className='text-sm leading-6 text-foreground/90'>{section.summary}</p>
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
                          href: buildDrillHref(section.drill_to),
                          label: buildDrillLabel(section.drill_to),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <Radar className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>风险提醒</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='space-y-3 pt-0'>
            {data.issue_cards.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有明显风险信号。' />
            ) : (
              data.issue_cards.map((item) => (
                <div
                  key={`${item.title}-${item.level}`}
                  className='rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                >
                  <div className='mb-2 flex items-center gap-2'>
                    <AlertCircle className='h-4 w-4 text-amber-500' />
                    <p className='font-medium'>{item.title}</p>
                    <Badge variant='outline'>{item.level}</Badge>
                    {buildDrillLabel(item.drill_to) ? (
                      <Badge variant='secondary'>{buildDrillLabel(item.drill_to)}</Badge>
                    ) : null}
                  </div>
                  <p className='text-sm leading-6 text-muted-foreground'>{item.summary}</p>
                  {item.next_step ? (
                    <p className='mt-2 text-sm leading-6 text-foreground/80'>{item.next_step}</p>
                  ) : null}
                  <div className='mt-3'>
                    <AdAnalysisDrillLinks
                      links={[
                        {
                          href: buildDrillHref(item.drill_to),
                          label: buildDrillLabel(item.drill_to),
                        },
                      ]}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <TrendingUp className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>高消耗活动</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='pt-0'>
            {data.top_campaigns.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有广告活动明细。' />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>活动</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Sales</TableHead>
                    <TableHead>Orders</TableHead>
                    <TableHead>ACOS</TableHead>
                    <TableHead>下钻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_campaigns.map((item, index) => (
                    <TableRow key={`${String(item.campaign_name)}-${index}`}>
                      <TableCell>{String(item.campaign_name || '-')}</TableCell>
                      <TableCell>${Number(item.spend || 0).toFixed(2)}</TableCell>
                      <TableCell>${Number(item.sales_7d || 0).toFixed(2)}</TableCell>
                      <TableCell>{String(item.orders_7d || 0)}</TableCell>
                      <TableCell>{(Number(item.acos || 0) * 100).toFixed(2)}%</TableCell>
                      <TableCell>
                        <AdAnalysisDrillLinks
                          links={[
                            {
                              href: buildAnalysisDrillHref(
                                'campaigns',
                                { projectId, country, dateFrom, dateTo },
                                { campaign: String(item.campaign_name || '') },
                              ),
                              label: '活动',
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid items-start gap-5 xl:grid-cols-2'>
        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <BarChart3 className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>高消耗 SKU</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='pt-0'>
            {data.top_products.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有推广商品明细。' />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Sales</TableHead>
                    <TableHead>Orders</TableHead>
                    <TableHead>ACOS</TableHead>
                    <TableHead>下钻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_products.map((item, index) => (
                    <TableRow key={`${String(item.ad_sku)}-${index}`}>
                      <TableCell>{String(item.ad_sku || '-')}</TableCell>
                      <TableCell>${Number(item.spend || 0).toFixed(2)}</TableCell>
                      <TableCell>${Number(item.sales_7d || 0).toFixed(2)}</TableCell>
                      <TableCell>{String(item.orders_7d || 0)}</TableCell>
                      <TableCell>{(Number(item.acos || 0) * 100).toFixed(2)}%</TableCell>
                      <TableCell>
                        <AdAnalysisDrillLinks
                          links={[
                            {
                              href: buildAnalysisDrillHref(
                                'products',
                                { projectId, country, dateFrom, dateTo },
                                { sku: String(item.ad_sku || '') },
                              ),
                              label: 'SKU',
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <Search className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>浪费搜索词</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='pt-0'>
            {data.top_waste_terms.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有达到观察门槛的浪费搜索词。' />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>搜索词</TableHead>
                    <TableHead>活动</TableHead>
                    <TableHead>Clicks</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Orders</TableHead>
                    <TableHead>下钻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_waste_terms.map((item, index) => (
                    <TableRow key={`${String(item.search_term)}-${index}`}>
                      <TableCell>{String(item.search_term || '-')}</TableCell>
                      <TableCell>{String(item.campaign_name || '-')}</TableCell>
                      <TableCell>{String(item.clicks || 0)}</TableCell>
                      <TableCell>${Number(item.spend || 0).toFixed(2)}</TableCell>
                      <TableCell>{String(item.orders_7d || 0)}</TableCell>
                      <TableCell>
                        <AdAnalysisDrillLinks
                          links={[
                            {
                              href: buildAnalysisDrillHref(
                                'search-terms',
                                { projectId, country, dateFrom, dateTo },
                                { searchTerm: String(item.search_term || '') },
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
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid items-start gap-5 xl:grid-cols-2'>
        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <TimerReset className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>近 7 日趋势</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='pt-0'>
            {data.trend_summary.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有趋势明细。' />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>日期</TableHead>
                    <TableHead>Spend</TableHead>
                    <TableHead>Clicks</TableHead>
                    <TableHead>CPC</TableHead>
                    <TableHead>变化</TableHead>
                    <TableHead>下钻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.trend_summary.map((item, index) => (
                    <TableRow key={`${String(item.report_date)}-${index}`}>
                      <TableCell>{String(item.report_date || '-')}</TableCell>
                      <TableCell>${Number(item.spend || 0).toFixed(2)}</TableCell>
                      <TableCell>{String(item.clicks || 0)}</TableCell>
                      <TableCell>${Number(item.cpc || 0).toFixed(2)}</TableCell>
                      <TableCell>{(Number(item.spend_change_ratio || 0) * 100).toFixed(2)}%</TableCell>
                      <TableCell>
                        <AdAnalysisDrillLinks
                          links={[
                            {
                              href: buildAnalysisDrillHref(
                                'time-trend',
                                { projectId, country, dateFrom, dateTo },
                                { focusDate: String(item.report_date || '') },
                              ),
                              label: '趋势',
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <Boxes className='h-4 w-4 text-primary' />
              <CardTitle className='text-lg'>关联购买机会</CardTitle>
            </div>
          </CardHeader>
          <CardContent className='pt-0'>
            {data.top_cross_sell_products.length === 0 ? (
              <EmptyState rowHeight='md' message='当前没有明显的关联购买贡献。' />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>广告 SKU</TableHead>
                    <TableHead>关联 ASIN</TableHead>
                    <TableHead>Sales</TableHead>
                    <TableHead>Orders</TableHead>
                    <TableHead>动作</TableHead>
                    <TableHead>下钻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_cross_sell_products.map((item, index) => (
                    <TableRow key={`${String(item.ad_sku)}-${String(item.purchased_asin)}-${index}`}>
                      <TableCell>{String(item.ad_sku || '-')}</TableCell>
                      <TableCell>{String(item.purchased_asin || '-')}</TableCell>
                      <TableCell>${Number(item.other_sku_sales_7d || 0).toFixed(2)}</TableCell>
                      <TableCell>{String(item.other_sku_orders_7d || 0)}</TableCell>
                      <TableCell>
                        <Badge variant='outline'>{String(item.action || '-')}</Badge>
                      </TableCell>
                      <TableCell>
                        <AdAnalysisDrillLinks
                          links={[
                            {
                              href: buildAnalysisDrillHref(
                                'purchased-products',
                                { projectId, country, dateFrom, dateTo },
                                {
                                  sku: String(item.ad_sku || ''),
                                  purchasedAsin: String(item.purchased_asin || ''),
                                },
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
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
