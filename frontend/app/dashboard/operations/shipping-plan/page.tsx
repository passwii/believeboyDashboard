import type { Metadata } from 'next'
import ShippingPlanClient from './shipping-plan-client'

export const metadata: Metadata = {
  title: '发货规划',
  description: '查看未来 180 天的 SKU 供给情景与销售上限，并维护预期到货计划。',
}

export default function ShippingPlanPage() {
  return <ShippingPlanClient />
}
