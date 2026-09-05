import { Metadata } from 'next'
import ComplaintCenterClient from './complaint-center-client'

export const metadata: Metadata = {
  title: '客诉中心',
  description: '每日巡检买家消息，管理待回复客诉',
}

export default function ComplaintCenterPage() {
  return <ComplaintCenterClient />
}
