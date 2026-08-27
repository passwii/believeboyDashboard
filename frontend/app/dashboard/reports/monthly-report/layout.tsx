'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileBarChart, LayoutDashboard, ShieldCheck } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

// BLF-867 Tabs 基座 Terminal 收口：由 variant="term" 统一承载 h-8/rounded-none/term 语义，消页面侧覆盖漂移。

const TAB_ITEMS = [
  { value: 'display', label: '财务报表', icon: LayoutDashboard },
  { value: 'generate', label: '制作报表', icon: FileBarChart },
  { value: 'reconcile', label: '报表核对', icon: ShieldCheck },
] as const

export default function MonthlyReportLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const activeTab = pathname.endsWith('/generate')
    ? 'generate'
    : pathname.endsWith('/reconcile')
      ? 'reconcile'
      : 'display'

  return (
    <div className="min-w-0 w-full space-y-3">
      <Tabs value={activeTab}>
        <TabsList variant="term" className="grid w-full max-w-md grid-cols-3 justify-start gap-0 bg-term-panel">
          {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} variant="term" asChild>
              <Link href={`/dashboard/reports/monthly-report/${value}`}>
                <Icon aria-hidden />
                {label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </div>
  )
}
