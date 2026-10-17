'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Gauge, PanelsTopLeft } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile, TermPill } from '@/components/terminal/term-controls'
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


type PlacementItem = {
  campaign_name: string
  placement: string
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
  roas: number
  action: string
  next_step: string
}

type PlacementSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type PlacementResponse = {
  project_id: number
  country: string
  summary_cards: PlacementSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: PlacementItem[]
}


export function AdAnalysisPlacementsClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const placementFilter = searchParams.get('placement') || ''
  const skuFilter = searchParams.get('sku') || ''

  const [data, setData] = useState<PlacementResponse | null>(null)
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
        if (placementFilter) query.set('placement', placementFilter)
        if (skuFilter) query.set('sku', skuFilter)
        // BEL-421: 2-min client cache — repeat mounts within TTL make 0 requests
        const payload = await fetchAdAnalysisCached<PlacementResponse>('placements', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active)
          setError(fetchError instanceof Error ? fetchError.message : '广告位分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, placementFilter, projectId, session, skuFilter, status, refreshKey])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载广告位分析..." />
  if (error) {
    return (
      <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
        ERR · {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有广告位明细。" />

  const narrativeSections = data.narrative_sections ?? []

  const filteredItems = placementFilter
    ? data.items.filter((item) =>
        item.placement.toLowerCase().includes(placementFilter.toLowerCase())
      )
    : data.items

  if (filteredItems.length === 0) {
    return (
      <EmptyState rowHeight="lg" message={`当前筛选下没有匹配“${placementFilter}”的广告位。`} />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(placementFilter ? [{ label: '当前广告位', value: placementFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* BLF-611：手机端汇总卡一行两个（总则 1）；数字降级防挤压；md+ 行为不变 */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {data.summary_cards.map((card) => (
          <TermKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      <DeferredSection fallbackHeight="h-[280px]" data-testid="placements-deferred-narrative">
      <TermPanel title="广告位层分析" bodyClassName="p-2">
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
                          placement: placementFilter || undefined,
                          sku: skuFilter || undefined,
                        }
                      ),
                      label: section.drill_to === 'campaigns' ? '活动' : '广告位',
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      </TermPanel>
      </DeferredSection>

      <DeferredSection fallbackHeight="h-[420px]" data-testid="placements-deferred-table">
      <TermPanel title="活动层分析" bodyClassName="p-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
            <PanelsTopLeft className="h-4 w-4 text-primary" />
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>广告位</TableHead>
                  <TableHead>活动</TableHead>
                  <TableHead>建议</TableHead>
                  <TableHead>Spend</TableHead>
                  <TableHead>Sales</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>下一步</TableHead>
                  <TableHead>ACOS</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={`${item.campaign_name}-${item.placement}`}>
                    <TableCell className="font-mono text-xs font-medium text-term-text">{item.placement}</TableCell>
                    <TableCell>{item.campaign_name}</TableCell>
                    <TableCell>
                      <TermPill tone="muted"><Gauge className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </TermPill>
                    </TableCell>
                    <TableCell>${item.spend.toFixed(2)}</TableCell>
                    <TableCell>${item.sales_7d.toFixed(2)}</TableCell>
                    <TableCell>{item.orders_7d}</TableCell>
                    <TableCell className="max-w-[220px] text-sm text-muted-foreground">
                      {item.next_step}
                    </TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell>
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              {
                                campaign: item.campaign_name,
                                sku: skuFilter || undefined,
                                placement: item.placement,
                              }
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'placements',
                              { projectId, country, dateFrom, dateTo },
                              {
                                campaign: item.campaign_name,
                                sku: skuFilter || undefined,
                                placement: item.placement,
                              }
                            ),
                            label: '聚焦',
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
                key={`${item.campaign_name}-${item.placement}`}
                className="rounded-none border border-term-border bg-term-panel p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2 border-b border-term-border pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.placement}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.campaign_name}</p>
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
                </div>

                <div className="text-xs text-muted-foreground border-t border-term-border pt-2">
                  下一步: {item.next_step}
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
                        { campaign: item.campaign_name, placement: item.placement }
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
                        'placements',
                        { projectId, country, dateFrom, dateTo },
                        { campaign: item.campaign_name, placement: item.placement }
                      )
                      if (href) window.location.href = href
                    }}
                  >
                    聚焦
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
