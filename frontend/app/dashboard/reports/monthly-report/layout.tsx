'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileBarChart, LayoutDashboard } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TAB_ITEMS = [
  { value: 'display', label: '财务报表', icon: LayoutDashboard },
  { value: 'generate', label: '制作报表', icon: FileBarChart },
] as const

export default function MonthlyReportLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const activeTab = pathname.endsWith('/generate') ? 'generate' : 'display'

  return (
    <div className="min-w-0 w-full space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            财务月报
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            月度财务报表的生成与查看
          </p>
        </div>
        <Tabs value={activeTab}>
          <TabsList className="grid w-full max-w-sm grid-cols-2">
            {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} asChild>
                <Link
                  href={`/dashboard/reports/monthly-report/${value}`}
                  className="flex items-center gap-1.5"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {children}
    </div>
  )
}
