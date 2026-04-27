import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Store } from 'lucide-react'

export default function BusinessDevReportsPage() {
  return (
    <div className='space-y-6'>
      <div className='flex items-center gap-3'>
        <div className='flex h-10 w-10 items-center justify-center rounded-[0.75rem] bg-[linear-gradient(180deg,#1a3a5c,#2a5a8c)] text-[#b3d4ff]'>
          <Store className='h-5 w-5' />
        </div>
        <div>
          <p className='text-sm text-muted-foreground'>功能开发中，稍后将开放使用</p>
        </div>
      </div>

      <Card className='dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]'>
        <CardHeader>
          <CardTitle>功能预留</CardTitle>
          <CardDescription>招商报表模块正在建设中</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex min-h-[200px] items-center justify-center rounded-md border border-dashed border-border bg-[hsl(var(--surface-subtle))] p-8 dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]'>
            <div className='text-center'>
              <Store className='mx-auto mb-3 h-10 w-10 text-muted-foreground/40' />
              <p className='text-sm font-medium text-muted-foreground'>功能开发中</p>
              <p className='mt-1 text-xs text-muted-foreground/60'>该模块即将上线，请耐心等待</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
