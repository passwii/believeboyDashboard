'use client'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function AdAnalysisPage() {
  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge variant="outline" className="w-fit rounded-md border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                数据管理
              </Badge>
              <p className="text-sm text-muted-foreground">广告分析页面正在设计中，敬请期待...</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>广告分析</CardTitle>
              <CardDescription>页面设计开发中，暂不对外开放</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex h-[300px] items-center justify-center rounded-md border border-dashed">
                <p className="text-sm text-muted-foreground">广告分析模块正在设计中</p>
              </div>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  )
}
