'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileBarChart, LayoutDashboard, ShieldCheck } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

// BLF-836 终端化：页面标题由 TerminalHeader 面包屑承载；Tab 条换终端规格。
const TERM_TRIGGER_CLASS =
  'h-8 rounded-none gap-1.5 px-3 text-xs text-term-muted data-[state=active]:bg-term-raised data-[state=active]:text-term-text [&_svg]:h-3.5 [&_svg]:w-3.5'

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
        <TabsList className="grid h-8 w-full max-w-md grid-cols-3 justify-start gap-0 rounded-none border border-term-border bg-term-panel p-0">
          {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} asChild className={TERM_TRIGGER_CLASS}>
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
