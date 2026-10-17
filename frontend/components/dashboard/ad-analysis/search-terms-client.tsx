'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Search, TrendingUp } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile, TermPill } from '@/components/terminal/term-controls'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
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

  const [data, setData] = useState<SearchTermsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshKey = useAdClientRefreshKey()

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
        if (searchTermFilter) query.set('search_term', searchTermFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<SearchTermsResponse>('search-terms', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active)
          setError(fetchError instanceof Error ? fetchError.message : '搜索词分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, searchTermFilter, session, skuFilter, status, refreshKey])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载搜索词分析..." />
  if (error) {
    return (
      <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
        ERR · {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有搜索词明细。" />

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = searchTermFilter
    ? data.items.filter((item) =>
        item.search_term.toLowerCase().includes(searchTermFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return (
      <EmptyState rowHeight="lg" message={`当前筛选下没有匹配“${searchTermFilter}”的搜索词。`} />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(searchTermFilter ? [{ label: '当前搜索词', value: searchTermFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* BLF-611：手机端汇总卡一行两个（总则 1）；数字降级防挤压；md+ 行为不变 */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {data.summary_cards.map((card) => (
          <TermKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <DeferredSection fallbackHeight="h-[280px]" data-testid="search-terms-deferred-narrative">
      <TermPanel title="搜索词层分析" bodyClassName="p-2">
          <div className="space-y-1">
          {narrativeSections.map((section) => (
            <div
              key={section.title}
              className="rounded-none border border-term-border bg-term-panel px-2 py-1.5"
            >
              <p className="font-mono text-xs font-medium text-term-text">{section.title}</p>
              <p className="mt-1 font-mono text-xs leading-5 text-term-muted">{section.summary}</p>
              <div className="mt-1 space-y-0.5 font-mono text-xs text-term-faint">
                {section.evidence.map((evidence) => (
                  <p key={evidence}>- {evidence}</p>
                ))}
              </div>
              {section.action ? (
                <p className="mt-1 font-mono text-xs leading-5 text-term-muted">动作：{section.action}</p>
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
      </TermPanel>
      </DeferredSection>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="search-terms-deferred-table">
      <TermPanel title="活动层分析" bodyClassName="p-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Search className="h-4 w-4 text-primary" />
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
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-mono text-xs font-medium text-term-text">{item.search_term}</p>
                        <p className="font-mono text-xs text-term-muted">
                          {item.match_type} / {item.campaign_count} 个活动
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TermPill tone="muted"><TrendingUp className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </TermPill>
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
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.primary_campaign }
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
          <div className="lg:hidden space-y-3">
            {filteredItems.map((item) => (
              <div
                key={`${item.search_term}-${item.match_type}`}
                className="rounded-none border border-term-border bg-term-panel p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2 border-b border-term-border pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.search_term}</p>
                    <p className="font-mono text-xs text-term-muted">
                      {item.match_type} / {item.campaign_count} 个活动
                    </p>
                  </div>
                  <TermPill tone="info">{item.action}</TermPill>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="font-mono text-xs text-term-muted">Spend</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.spend.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">Sales</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.sales_7d.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">Orders</span>
                    <div className="font-mono text-xs font-medium text-term-text">{item.orders_7d}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">ACOS</span>
                    <div
                      className={cn(
                        'font-medium',
                        item.acos > 0.3 ? 'text-term-neg' : 'text-term-pos'
                      )}
                    >
                      {(item.acos * 100).toFixed(2)}%
                    </div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">CTR</span>
                    <div className="font-mono text-xs font-medium text-term-text">{(item.ctr * 100).toFixed(2)}%</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">CVR</span>
                    <div className="font-mono text-xs font-medium text-term-text">{(item.cvr_7d * 100).toFixed(2)}%</div>
                  </div>
                </div>

                <div className="font-mono text-xs text-term-muted">
                  份额: {(item.impression_share * 100).toFixed(2)}% / 排名:{' '}
                  {item.impression_rank || '-'}
                </div>

                <div className="flex gap-2 pt-2 border-t border-term-border">
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
                        'targets',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.primary_campaign }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    投放
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </TermPanel>
      </DeferredSection>
    </div>
  )
}
