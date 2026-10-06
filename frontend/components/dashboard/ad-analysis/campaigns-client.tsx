'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Activity, Layers3 } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile, TermPill } from '@/components/terminal/term-controls'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'
import { cn } from '@/lib/utils'


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

  const [data, setData] = useState<CampaignResponse | null>(null)
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
        if (searchTermFilter) query.set('search_term', searchTermFilter)
        if (placementFilter) query.set('placement', placementFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<CampaignResponse>('campaigns', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '活动分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, placementFilter, projectId, searchTermFilter, session, skuFilter, status])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载活动分析..." />
  if (error) {
    return (
      <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
        ERR · {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有广告活动明细。" />

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = campaignFilter
    ? data.items.filter((item) =>
        item.campaign_name.toLowerCase().includes(campaignFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return <EmptyState rowHeight="lg" message={`当前筛选下没有匹配“${campaignFilter}”的活动。`} />
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(searchTermFilter ? [{ label: '当前搜索词', value: searchTermFilter }] : []),
          ...(placementFilter ? [{ label: '当前广告位', value: placementFilter }] : []),
        ]}
      />
      {/* BLF-611：手机端汇总卡一行两个（总则 1）；数字降级防挤压；md+ 行为不变 */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-testid="campaign-summary-cards">
        {data.summary_cards.map((card) => (
          <div key={card.label} data-testid="campaign-summary-card">
            <TermKpiTile label={card.label} value={card.value} />
          </div>
        ))}
      </div>

      <DeferredSection fallbackHeight="h-[280px]" data-testid="campaigns-deferred-narrative">
      <TermPanel title="活动层分析" bodyClassName="p-2">
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
      </TermPanel>
      </DeferredSection>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="campaigns-deferred-table">
      <TermPanel title="活动分级" bodyClassName="p-0">
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>活动</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Sales</TableHead>
                  <TableHead>预算缺口</TableHead>
                  <TableHead>关联销售</TableHead>
                  <TableHead>下一步</TableHead>
                  <TableHead>ACOS</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.campaign_name}>
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-mono text-xs font-medium text-term-text">{item.campaign_name}</p>
                        <p className="font-mono text-xs text-term-muted">
                          {item.status} / {item.bidding_strategy}
                        </p>
                        <p className="font-mono text-xs text-term-muted">
                          CTR {(item.ctr * 100).toFixed(2)}% / 预算在线{' '}
                          {(item.budget_utilization_rate * 100).toFixed(2)}%
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TermPill tone="muted">{item.grade}
                      </TermPill>
                    </TableCell>
                    <TableCell>{item.targeting_type}</TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.sales_7d.toFixed(2)}</TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p>${item.budget_gap.toFixed(2)}</p>
                        <p className="font-mono text-xs text-term-muted">
                          错失销售 ${item.missed_sales_max.toFixed(2)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="space-y-1 text-sm">
                        <p>${item.cross_sell_sales_7d.toFixed(2)}</p>
                        <p className="font-mono text-xs text-term-muted">
                          {item.cross_sell_orders_7d} 单
                        </p>
                        <TermPill tone="muted">{item.cross_sell_action}</TermPill>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TermPill tone="muted">{item.next_action}</TermPill>
                    </TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell className="align-top">
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
                key={item.campaign_name}
                data-testid="campaign-mobile-card"
                className="rounded-none border border-term-border bg-term-panel p-3 space-y-2"
              >
                {/* 头部：活动名 + Grade */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.campaign_name}</p>
                    <p className="font-mono text-xs text-term-muted">
                      {item.status} / {item.bidding_strategy}
                    </p>
                    <p className="font-mono text-xs text-term-muted">
                      CTR {(item.ctr * 100).toFixed(2)}% / 预算在线{' '}
                      {(item.budget_utilization_rate * 100).toFixed(2)}%
                    </p>
                  </div>
                  <TermPill tone="muted">{item.grade}</TermPill>
                </div>

                {/* 核心数据 2x3 网格 */}
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
                    <span className="font-mono text-xs text-term-muted">类型</span>
                    <div className="text-xs">{item.targeting_type}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">预算缺口</span>
                    <div className="font-medium text-term-warn">${item.budget_gap.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">关联销售</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.cross_sell_sales_7d.toFixed(2)}</div>
                  </div>
                </div>

                {/* 错失销售 */}
                {item.missed_sales_max > 0 && (
                  <div className="text-xs text-term-warn">
                    错失销售: ${item.missed_sales_max.toFixed(2)}
                  </div>
                )}

                {/* 操作按钮 */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-term-border">
                  <TermPill tone="muted">{item.next_action}</TermPill>
                  <TermPill tone="muted">{item.cross_sell_action}</TermPill>
                </div>

                {/* 下钻链接 */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'budget',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.campaign_name }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    预算
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'products',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.campaign_name }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    SKU
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-h-[44px] text-xs"
                    onClick={() => {
                      const href = buildAnalysisDrillHref(
                        'search-terms',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.campaign_name }
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
      </TermPanel>
      </DeferredSection>
    </div>
  )
}
