'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

// recharts 强依赖 window/document，必须 ssr:false 才能从首屏 bundle 拆出 recharts 主体
// charts.tsx 作为 VisitorsChart 入口：所有从其他模块引 VisitorsChart 时走 dynamic 路径，
// 避免在调用方的 chunk 中静态拉入 recharts 主体（~400KB）
const LazyVisitorsChart = dynamic(
  () => import('./visitors-chart').then((m) => m.VisitorsChart),
  {
    ssr: false,
    loading: () => (
      <div className='dashboard-surface col-span-1 rounded-xl p-5 lg:col-span-4'>
        <div className='flex items-center justify-between pb-4'>
          <div className='space-y-2'>
            <Skeleton className='h-3 w-16' />
            <Skeleton className='h-5 w-32' />
            <Skeleton className='h-3 w-44' />
          </div>
          <Skeleton className='h-11 w-[170px] rounded-md' />
        </div>
        <div className='mb-5 flex gap-3'>
          <Skeleton className='h-7 w-32 rounded-md' />
          <Skeleton className='h-7 w-32 rounded-md' />
          <Skeleton className='h-7 w-24 rounded-md' />
        </div>
        <Skeleton className='h-[320px] w-full rounded-lg' />
      </div>
    ),
  },
)

// 保持命名导出 VisitorsChart 以便现有/未来调用方使用 —— 名字还是 VisitorsChart
// 但内部实现走 dynamic 拉取，与直接 export function 不同
export const VisitorsChart = LazyVisitorsChart
