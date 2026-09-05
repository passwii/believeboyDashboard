import { Metadata } from 'next'
import ComplaintListClient from './complaint-list-client'

export const metadata: Metadata = {
  title: '客诉明细',
  description: '客诉明细列表，筛选、排序、状态流转',
}

export default function ComplaintListPage() {
  return <ComplaintListClient />
}
