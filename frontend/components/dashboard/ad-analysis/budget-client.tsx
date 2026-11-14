'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { BadgeDollarSign } from 'lucide-react'

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

  const [dataResult, setDataResult] = useState<{ signature: string; value: BudgetResponse } | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(
    null
  )
  const refreshKey = useAdClientRefreshKey()
  const sessionUser = session?.user as
    | { id?: string | null; roleType?: string | null; name?: string | null }
    | undefined
  const querySignature = JSON.stringify([
    projectId,
    country,
    dateFrom,
    dateTo,
    campaignFilter,
    skuFilter,
    sessionUser?.id ?? null,
    sessionUser?.roleType ?? null,
    sessionUser?.name ?? null,
  ])
  const data = dataResult?.signature === querySignature ? dataResult.value : null
  const error = errorResult?.signature === querySignature ? errorResult.message : null
  const isLoading = loading || (Boolean(projectId) && status !== 'loading' && !data && !error)

  useEffect(() => {
    if (!projectId) return
    // BEL-421：缓存键按用户域隔离，等 session 就绪再取数，避免 unknown 域双请求
    if (status === 'loading') return
    let active = true
    setDataResult((current) => (current?.signature === querySignature ? current : null))
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
        // BEL-421：客户端缓存（2min TTL）——重复 mount 0 请求
        const payload = await fetchAdAnalysisCached<BudgetResponse>('budget', query, session)
        if (active) setDataResult({ signature: querySignature, value: payload })
      } catch (fetchError) {
        if (active) {
          setErrorResult({
            signature: querySignature,
            message: fetchError instanceof Error ? fetchError.message : '预算分析加载失败',
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
  }, [
    campaignFilter,
    country,
    dateFrom,
    dateTo,
    projectId,
    querySignature,
    session,
    skuFilter,
    status,
    refreshKey,
  ])

  if (!projectId) return <WarmEmptyState rowHeight="lg" message="请先选择项目。" />
  if (isLoading && !data) return <WarmEmptyState rowHeight="lg" message="正在加载预算分析..." />
  if (error && !data) {
    return <WarmErrorBar message={error} />
  }
  if (!data) return <WarmEmptyState rowHeight="lg" message="当前没有预算明细。" />
  if (data.items.length === 0) {
    return (
      <>
        <WarmRefreshStatus loading={loading} error={error} hasData />
        <WarmEmptyState rowHeight="lg" message="当前没有预算明细。" />
      </>
    )
  }

  const narrativeSections = data.narrative_sections ?? []

  return (
    <div className="flex min-w-0 flex-col gap-3" data-warm-ad-analysis-page="budget">
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

      {/* BEL-421：非首屏区块 —— 叙述分析推迟到滚动接近时再挂载渲染 */}
      <WarmDeferredSection fallbackHeight="h-[280px]" data-testid="budget-deferred-narrative">
        <WarmPanel title="预算层分析" bodyClassName="p-2">
          <div className="divide-y divide-[var(--warm-ledger-color-hairline)]">
            {narrativeSections.map((section) => (
              <div key={section.title} className="py-2 first:pt-0 last:pb-0">
                <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                  {section.title}
                </p>
                <p className="mt-1 font-sans text-xs leading-5 text-[var(--warm-ledger-color-text-muted)]">
                  {section.summary}
                </p>
                <div className="mt-1 space-y-0.5 font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                  {section.evidence.map((evidence) => (
                    <p key={evidence}>- {evidence}</p>
                  ))}
                </div>
                {section.action ? (
                  <p className="mt-1 font-sans text-xs leading-5 text-[var(--warm-ledger-color-text-muted)]">
                    动作：{section.action}
                  </p>
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
        </WarmPanel>
      </WarmDeferredSection>

      {/* BEL-421：非首屏区块 —— 预算明细表推迟挂载 */}
      <WarmDeferredSection fallbackHeight="h-[420px]" data-testid="budget-deferred-table">
        <WarmPanel title="活动层分析" bodyClassName="p-0">
          <div className="w-full min-w-0">
            {/* 桌面端：完整表格 */}
            <WarmTable>
              <WarmTHead>
                <WarmRow>
                  <WarmHead>活动</WarmHead>
                  <WarmHead>动作</WarmHead>
                  <WarmHead numeric>当前预算</WarmHead>
                  <WarmHead numeric>建议预算</WarmHead>
                  <WarmHead numeric>预算在线时间</WarmHead>
                  <WarmHead numeric>错失销售额</WarmHead>
                  <WarmHead>下一步</WarmHead>
                  <WarmHead numeric>ACOS</WarmHead>
                  <WarmHead>下钻</WarmHead>
                </WarmRow>
              </WarmTHead>
              <WarmBody>
                {data.items.map((item) => (
                  <WarmRow key={item.campaign_name}>
                    <WarmCell className="align-top">
                      <div className="space-y-1">
                        <p className="font-sans text-xs font-medium text-[var(--warm-ledger-color-text)]">
                          {item.campaign_name}
                        </p>
                        <p className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {item.status}
                        </p>
                      </div>
                    </WarmCell>
                    <WarmCell>
                      <WarmPill tone="muted">
                        <BadgeDollarSign className="mr-1 h-3.5 w-3.5" />
                        {item.action}
                      </WarmPill>
                    </WarmCell>
                    <WarmCell numeric>${item.budget.toFixed(2)}</WarmCell>
                    <WarmCell numeric>${item.suggested_budget.toFixed(2)}</WarmCell>
                    <WarmCell numeric>{(item.budget_utilization_rate * 100).toFixed(2)}%</WarmCell>
                    <WarmCell>
                      <WarmNumber>
                        ${item.missed_sales_min.toFixed(2)} - ${item.missed_sales_max.toFixed(2)}
                      </WarmNumber>
                    </WarmCell>
                    <WarmCell className="max-w-[220px] text-sm text-[var(--warm-ledger-color-text-muted)]">
                      {item.next_step}
                    </WarmCell>
                    <WarmCell numeric>{(item.acos * 100).toFixed(2)}%</WarmCell>
                    <WarmCell className="align-top">
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
