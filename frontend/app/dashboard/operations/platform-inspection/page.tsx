import { Metadata } from 'next'
import InspectionClient from './inspection-client'

export const metadata: Metadata = {
  title: '平台巡检',
  description: '定期记录账户健康状态、截图和状态说明',
}

export default function PlatformInspectionPage() {
  return <InspectionClient />
}
