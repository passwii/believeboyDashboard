'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { BadgeDollarSign, Wallet } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { DeferredSection } from '@/components/dashboard/deferred-section'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile, TermPill } from '@/components/terminal/term-controls'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
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

type BudgetItem = {
  campaign_name: string
  status: string
  budget: number
  suggested_budget: number
  budget_gap: number
  budget_utilization_rate: number
  missed_impressions_min: number
  missed_impressions_max: number
  missed_clicks_min: number
  missed_clicks_max: number
  missed_sales_min: number
  missed_sales_max: number
  spend: number
  sales_7d: number
  orders_7d: number
  acos: number
  action: string
  next_step: string
}

type BudgetSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type BudgetResponse = {
  project_id: number
  country: string
  summary_cards: BudgetSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: BudgetItem[]
}

export function AdAnalysisBudgetClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''
  const skuFilter = searchParams.get('sku') || ''

  const [data, setData] = useState<BudgetResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshKey = useAdClientRefreshKey()

  useEffect(() => {
    if (!projectId) return
    // BEL-421：缓存键按用户域隔离，等 session 就绪再取数，避免 unknown 域双请求
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
        // BEL-421：客户端缓存（2min TTL）——重复 mount 0 请求
        const payload = await fetchAdAnalysisCached<BudgetResponse>('budget', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) setError(fetchError instanceof Error ? fetchError.message : '预算分析加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, session, skuFilter, status, refreshKey])

  if (!projectId) return <EmptyState rowHeight="lg" message="请先选择项目。" />
  if (loading) return <EmptyState rowHeight="lg" message="正在加载预算分析..." />
  if (error) {
    return (
      <div className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
        ERR · {error}
      </div>
    )
  }
  if (!data || data.items.length === 0)
    return <EmptyState rowHeight="lg" message="当前没有预算明细。" />

  const narrativeSections = data.narrative_sections ?? []

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
        ]}
      />
      {/* BLF-611：手机端汇总卡一行两个（总则 1）；数字降级防挤压；md+ 行为不变 */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {data.summary_cards.map((card) => (
          <TermKpiTile key={card.label} label={card.label} value={card.value} />
        ))}
      </div>

      {/* BEL-421：非首屏区块 —— 叙述分析推迟到滚动接近时再挂载渲染 */}
      <DeferredSection fallbackHeight="h-[280px]" data-testid="budget-deferred-narrative">
      <TermPanel title="预算层分析" bodyClassName="p-2">
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
                        }
                      ),
                      label:
                        section.drill_to === 'search-terms'
                          ? '搜索词'
                          : section.drill_to === 'campaigns'
                            ? '活动'
                            : '预算',
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      </TermPanel>
      </DeferredSection>

      {/* BEL-421：非首屏区块 —— 预算明细表推迟挂载 */}
      <DeferredSection fallbackHeight="h-[420px]" data-testid="budget-deferred-table">
      <TermPanel title="活动层分析" bodyClassName="p-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Wallet className="h-4 w-4 text-primary" />
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>活动</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>当前预算</TableHead>
                  <TableHead>建议预算</TableHead>
                  <TableHead>预算在线时间</TableHead>
                  <TableHead>错失销售额</TableHead>
                  <TableHead>下一步</TableHead>
                  <TableHead>ACOS</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.campaign_name}>
                    <TableCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-mono text-xs font-medium text-term-text">{item.campaign_name}</p>
                        <p className="font-mono text-xs text-term-muted">{item.status}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TermPill tone="muted"><BadgeDollarSign className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </TermPill>
                    </TableCell>
                    <TableCell>${item.budget.toFixed(2)}</TableCell>
                    <TableCell>${item.suggested_budget.toFixed(2)}</TableCell>
                    <TableCell>{(item.budget_utilization_rate * 100).toFixed(2)}%</TableCell>
                    <TableCell>
                      ${item.missed_sales_min.toFixed(2)} - ${item.missed_sales_max.toFixed(2)}
                    </TableCell>
                    <TableCell className="max-w-[220px] text-sm text-muted-foreground">
                      {item.next_step}
                    </TableCell>
                    <TableCell>{(item.acos * 100).toFixed(2)}%</TableCell>
                    <TableCell className="align-top">
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name }
                            ),
                            label: '活动',
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
            {data.items.map((item) => (
              <div key={item.campaign_name} className="rounded-none border border-term-border bg-term-panel p-3 space-y-2">
                <div className="flex items-start justify-between gap-2 border-b border-term-border pb-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{item.campaign_name}</p>
                    <p className="font-mono text-xs text-term-muted">{item.status}</p>
                  </div>
                  <TermPill tone="info">{item.action}</TermPill>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="font-mono text-xs text-term-muted">当前预算</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.budget.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">建议预算</span>
                    <div className="font-mono text-xs font-medium text-term-text">${item.suggested_budget.toFixed(2)}</div>
                  </div>
                  <div>
                    <span className="font-mono text-xs text-term-muted">预算在线</span>
                    <div className="font-mono text-xs font-medium text-term-text">
                      {(item.budget_utilization_rate * 100).toFixed(2)}%
                    </div>
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

                <div className="font-mono text-xs text-term-muted">
                  错失销售: ${item.missed_sales_min.toFixed(2)} - $
                  {item.missed_sales_max.toFixed(2)}
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
                        { campaign: item.campaign_name }
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
        </div>
      </TermPanel>
      </DeferredSection>
    </div>
  )
}
