import type { Metadata } from 'next'

import ReviewTrackingClient from './review-tracking-client'

export const metadata: Metadata = {
  title: '评论追踪',
  description: 'Amazon 商品评分趋势、评论明细与采集健康度，并维护外部竞品 ASIN 与店铺关联',
}

export default function ReviewTrackingPage() {
  return <ReviewTrackingClient />
}
