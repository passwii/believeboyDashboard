import { Skeleton } from '@/components/ui/skeleton'

/** v2 dashboard 路由级 loading：扁平工具栏 + 发丝线网格骨架（BLF-924 终端化适配） */
export default function DashboardV2Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-[180px]" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid grid-cols-2 gap-px bg-term-border p-px lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="bg-term-panel p-5" key={i}>
            <Skeleton className="mb-3 h-3 w-16" />
            <Skeleton className="mb-3 h-7 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
        {Array.from({ length: 2 }).map((_, i) => (
          <div className="bg-term-panel p-5 col-span-2" key={`wide-${i}`}>
            <Skeleton className="mb-2 h-5 w-24" />
            <Skeleton className="h-60 w-full md:h-80" />
          </div>
        ))}
      </div>
    </div>
  )
}
