'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, ShieldAlert } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

type TrafficQualityItem = {
  campaign_name: string
  status: string
  total_impressions: number
  valid_impressions: number
  invalid_impressions: number
  invalid_impression_rate: number
  total_clicks: number
  valid_clicks: number
  invalid_clicks: number
  invalid_click_rate: number
  risk_level: string
  next_step: string
}

type TrafficSummaryCard = {
  label: string
  value: string
  helper: string | null
}

type TrafficQualityResponse = {
  project_id: number
  country: string
  summary_cards: TrafficSummaryCard[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  items: TrafficQualityItem[]
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

function riskVariant(level: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (level === '高风险') return 'destructive'
  if (level === '中风险') return 'secondary'
  return 'outline'
}

export function AdAnalysisTrafficQualityClient() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const campaignFilter = searchParams.get('campaign') || ''

  const [data, setData] = useState<TrafficQualityResponse | null>(null)
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
        const response = await fetch(
          `${API_BASE}/api/v1/ad-analysis/traffic-quality?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as TrafficQualityResponse
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : '流量质量分析加载失败')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId])

  if (!projectId) return <EmptyState rowHeight='lg' message='请先选择项目。' />
  if (loading) return <EmptyState rowHeight='lg' message='正在加载流量质量分析...' />
  if (error) {
    return (
      <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0) return <EmptyState rowHeight='lg' message='当前没有流量质量明细。' />

  const narrativeSections = data.narrative_sections ?? []

  return (
    <div className='space-y-5'>
      <AdAnalysisContextBanner items={campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []} />
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
          <CardTitle className='text-lg'>流量质量层分析</CardTitle>
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
                        { campaign: campaignFilter || undefined },
                      ),
                      label:
                        section.drill_to === 'targets'
                          ? '投放'
                          : section.drill_to === 'campaigns'
                            ? '活动'
                            : '流量',
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
            <ShieldAlert className='h-4 w-4 text-primary' />
            <CardTitle className='text-lg'>无效流量排查</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {/* 桌面端：完整表格 */}
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>活动</TableHead>
                  <TableHead>风险等级</TableHead>
                  <TableHead>总曝光 / 无效曝光</TableHead>
                  <TableHead>无效曝光率</TableHead>
                  <TableHead>总点击 / 无效点击</TableHead>
                  <TableHead>无效点击率</TableHead>
                  <TableHead>下一步</TableHead>
                  <TableHead>下钻</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.campaign_name}>
                    <TableCell className='align-top'>
                      <div className='space-y-1'>
                        <p className='font-medium'>{item.campaign_name}</p>
                        <p className='text-xs text-muted-foreground'>{item.status}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={riskVariant(item.risk_level)}>
                        <AlertTriangle className='mr-1 h-3.5 w-3.5' />
                        {item.risk_level}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {item.total_impressions} / {item.invalid_impressions}
                    </TableCell>
                    <TableCell>{(item.invalid_impression_rate * 100).toFixed(2)}%</TableCell>
                    <TableCell>
                      {item.total_clicks} / {item.invalid_clicks}
                    </TableCell>
                    <TableCell>{(item.invalid_click_rate * 100).toFixed(2)}%</TableCell>
                    <TableCell className='max-w-[220px] text-sm text-muted-foreground'>{item.next_step}</TableCell>
                    <TableCell className='align-top'>
                      <AdAnalysisDrillLinks
                        links={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name },
                            ),
                            label: '活动',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'targets',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name },
                            ),
                            label: '投放',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'placements',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name },
                            ),
                            label: '广告位',
                          },
                          {
                            href: buildAnalysisDrillHref(
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: item.campaign_name },
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
          <div className='lg:hidden space-y-3'>
            {data.items.map((item) => (
              <div key={item.campaign_name} className='dashboard-surface p-4 space-y-3'>
                <div className='flex items-start justify-between gap-2 border-b border-border/70 pb-3'>
                  <div className='min-w-0 flex-1'>
                    <p className='font-medium text-sm'>{item.campaign_name}</p>
                    <p className='text-xs text-muted-foreground'>{item.status}</p>
                  </div>
                  <Badge variant={riskVariant(item.risk_level)} className='shrink-0'>
                    <AlertTriangle className='mr-1 h-3 w-3' />
                    {item.risk_level}
                  </Badge>
                </div>

                <div className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
                  <div>
                    <span className='text-xs text-muted-foreground'>总曝光</span>
                    <div className='font-medium'>{item.total_impressions.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>无效曝光率</span>
                    <div className={cn("font-medium", item.invalid_impression_rate > 0.1 ? 'text-red-500' : '')}>
                      {(item.invalid_impression_rate * 100).toFixed(2)}%
                    </div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>总点击</span>
                    <div className='font-medium'>{item.total_clicks.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className='text-xs text-muted-foreground'>无效点击率</span>
                    <div className={cn("font-medium", item.invalid_click_rate > 0.1 ? 'text-red-500' : '')}>
                      {(item.invalid_click_rate * 100).toFixed(2)}%
                    </div>
                  </div>
                </div>

                <div className='grid grid-cols-2 gap-x-4 gap-y-1 text-xs'>
                  <div>
                    <span className='text-muted-foreground'>无效曝光</span>
                    <div className='font-medium'>{item.invalid_impressions.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className='text-muted-foreground'>无效点击</span>
                    <div className='font-medium'>{item.invalid_clicks.toLocaleString()}</div>
                  </div>
                </div>

                <div className='text-xs text-muted-foreground border-t border-border/70 pt-2'>
                  下一步: {item.next_step}
                </div>

                <div className='flex gap-2 pt-2 border-t border-border/70'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-8 min-h-[44px] text-xs flex-1'
                    onClick={() => {
                      const href = buildAnalysisDrillHref('campaigns', { projectId, country, dateFrom, dateTo }, { campaign: item.campaign_name })
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
                      const href = buildAnalysisDrillHref('targets', { projectId, country, dateFrom, dateTo }, { campaign: item.campaign_name })
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
