'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileBarChart, LayoutDashboard, ShieldCheck } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import styles from './monthly-report-warm.module.css'

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
    <div className={styles.shell}>
      <Tabs value={activeTab}>
        <TabsList className={styles.tabList}>
          {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className={styles.tab} asChild>
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
