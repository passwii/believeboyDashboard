'use client'

import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  {
    key: 'subscriptions',
    label: '订阅管理',
    href: '/dashboard/data-analysis/scheduled-reports/subscriptions',
  },
  {
    key: 'ledger',
    label: '调度记录',
    href: '/dashboard/data-analysis/scheduled-reports/ledger',
  },
]

export default function ScheduledReportsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()

  const activeTab = TABS.find(t => pathname.startsWith(t.href))?.key ?? 'subscriptions'

  return (
    <div className="space-y-4">
      {/* 子导航 Tab Bar */}
      <div className="flex items-center gap-0.5 border-b border-border/60 bg-[hsl(var(--surface-panel))] rounded-t-lg px-1">
        {TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => router.push(tab.href)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors relative',
              'hover:text-foreground',
              activeTab === tab.key
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground/80',
            )}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        ))}
      </div>

      {children}
    </div>
  )
}
