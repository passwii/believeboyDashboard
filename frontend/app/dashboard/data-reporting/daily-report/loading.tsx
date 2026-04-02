import { CalendarDays, DatabaseZap, FileSearch, Sparkles, Upload } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

function FilterSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

function UploadPanelSkeleton({
  icon: Icon,
  title,
}: {
  icon: typeof Upload
  title: string
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span>{title}</span>
          </div>
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <Skeleton className="mt-4 h-2 w-full" />
    </div>
  )
}

export default function DailyReportLoading() {
  return (
    <div className="grid w-full gap-6 text-foreground xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <Card className="overflow-hidden border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90">
          <CardHeader>
            <CardTitle className="text-lg">控制台</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <FilterSkeleton />
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">报表日期</label>
                <div className="flex gap-2">
                  <Skeleton className="h-10 flex-1" />
                  <Skeleton className="h-10 w-24" />
                </div>
              </div>
              <FilterSkeleton />
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { icon: FileSearch, label: '识别' },
                { icon: Upload, label: '上传' },
                { icon: DatabaseZap, label: '处理进度' },
                { icon: Sparkles, label: '结果下载' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <item.icon className="h-3.5 w-3.5" />
                    <span>{item.label}</span>
                  </div>
                  <Skeleton className="mt-2 h-5 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90">
          <CardHeader>
            <CardTitle className="text-lg">文件映射与上传</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-2xl border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-8">
              <div className="flex flex-col items-center justify-center gap-3 text-center">
                <div className="rounded-2xl bg-background/80 p-3">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-72 max-w-full" />
                <Skeleton className="h-10 w-36" />
              </div>
            </div>

            <div className="grid gap-3">
              <UploadPanelSkeleton icon={FileSearch} title="销售报表" />
              <UploadPanelSkeleton icon={Sparkles} title="广告报表" />
              <UploadPanelSkeleton icon={CalendarDays} title="库存报告" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="border-border/70 bg-[hsl(var(--surface-panel))] shadow-[var(--shadow-soft)] dark:border-border/90">
          <CardHeader>
            <CardTitle className="text-lg">处理状态</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
