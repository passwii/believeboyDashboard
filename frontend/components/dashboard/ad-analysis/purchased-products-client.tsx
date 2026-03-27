'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Boxes, ShoppingBasket } from 'lucide-react'

import { AdAnalysisContextBanner } from '@/components/dashboard/ad-analysis/context-banner'
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

type PurchasedProductItem = {
  purchased_asin: string
  ad_sku: string
  campaign_count: number
  other_sku_units_7d: number
  other_sku_orders_7d: number
  other_sku_sales_7d: number
  action: string
}

type PurchasedProductsResponse = {
  project_id: number
  country: string
  items: PurchasedProductItem[]
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

export function AdAnalysisPurchasedProductsClient() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const skuFilter = searchParams.get('sku') || ''
  const purchasedAsinFilter = searchParams.get('purchasedAsin') || ''
  const campaignFilter = searchParams.get('campaign') || ''

  const [data, setData] = useState<PurchasedProductsResponse | null>(null)
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
        if (purchasedAsinFilter) query.set('purchased_asin', purchasedAsinFilter)
        const response = await fetch(
          `${API_BASE}/api/v1/ad-analysis/purchased-products?${query.toString()}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as PurchasedProductsResponse
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : '已购买商品分析加载失败')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [campaignFilter, country, dateFrom, dateTo, projectId, purchasedAsinFilter, skuFilter])

  if (!projectId) return <EmptyState rowHeight='lg' message='请先选择项目。' />
  if (loading) return <EmptyState rowHeight='lg' message='正在加载已购买商品分析...' />
  if (error) {
    return (
      <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'>
        {error}
      </div>
    )
  }
  if (!data || data.items.length === 0) return <EmptyState rowHeight='lg' message='当前没有已购买商品明细。' />

  const filteredItems = data.items.filter((item) => {
    const matchesSku = skuFilter ? item.ad_sku.toLowerCase().includes(skuFilter.toLowerCase()) : true
    const matchesPurchasedAsin = purchasedAsinFilter
      ? item.purchased_asin.toLowerCase().includes(purchasedAsinFilter.toLowerCase())
      : true
    return matchesSku && matchesPurchasedAsin
  })

  if (filteredItems.length === 0) {
    return <EmptyState rowHeight='lg' message='当前筛选下没有匹配的关联购买明细。' />
  }

  return (
    <div className='space-y-5'>
      <AdAnalysisContextBanner
        items={[
          ...(campaignFilter ? [{ label: '当前活动', value: campaignFilter }] : []),
          ...(skuFilter ? [{ label: '当前 SKU', value: skuFilter }] : []),
          ...(purchasedAsinFilter ? [{ label: '当前关联 ASIN', value: purchasedAsinFilter }] : []),
        ]}
      />

      <Card>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <ShoppingBasket className='h-4 w-4 text-primary' />
            <CardTitle className='text-lg'>广告带动的关联购买</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>关联 ASIN</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>广告 SKU</TableHead>
                <TableHead>活动数</TableHead>
                <TableHead>Units</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Sales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow key={`${item.purchased_asin}-${item.ad_sku}`}>
                  <TableCell className='font-medium'>{item.purchased_asin}</TableCell>
                  <TableCell>
                    <Badge variant='secondary'>
                      <Boxes className='mr-1 h-3.5 w-3.5' />
                      {item.action}
                    </Badge>
                  </TableCell>
                  <TableCell>{item.ad_sku}</TableCell>
                  <TableCell>{item.campaign_count}</TableCell>
                  <TableCell>{item.other_sku_units_7d}</TableCell>
                  <TableCell>{item.other_sku_orders_7d}</TableCell>
                  <TableCell>${item.other_sku_sales_7d.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
