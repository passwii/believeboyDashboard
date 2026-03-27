'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Crosshair, SlidersHorizontal } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
import { buildAnalysisDrillHref } from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const API_BASE = '/api/backend'

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

async function parseError(response: Response): Promise<string> {
  const raw = await response.text()
  try {
    const payload = JSON.parse(raw) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return raw || `请求失败 (${response.status})`
  }
}

export function AdAnalysisTargetsClient() {
  const searchParams = useSearchParams()
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
        const response = await fetch(
          `${API_BASE}/api/v1/ad-analysis/targets?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as TargetsResponse
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
  }, [campaignFilter, country, dateFrom, dateTo, projectId, skuFilter, targetTextFilter])

  if (!projectId) return <EmptyState rowHeight='lg' message='请先选择项目。' />
  if (loading) return <EmptyState rowHeight='lg' message='正在加载投放分析...' />
  if (error) {
    return (
      <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0) return <EmptyState rowHeight='lg' message='当前没有投放明细。' />

  return (
    <div className='space-y-5'>
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(targetTextFilter ? [{ label: '当前投放', value: targetTextFilter }] : []),
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
          <div className='flex items-center gap-2'>
            <Crosshair className='h-4 w-4 text-primary' />
            <CardTitle className='text-lg'>投放入口效率</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
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
                  <TableCell className='align-top'>
                    <div className='space-y-1'>
                      <p className='font-medium'>{item.target_text}</p>
                      <p className='text-xs text-muted-foreground'>
                        {item.match_type} / {item.campaign_count} 个活动
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant='secondary'>
                      <SlidersHorizontal className='mr-1 h-3.5 w-3.5' />
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
                            'search-terms',
                            { projectId, country, dateFrom, dateTo },
                            { campaign: item.primary_campaign },
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
        </CardContent>
      </Card>
    </div>
  )
}
