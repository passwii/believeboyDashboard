'use client'

import { usePathname } from 'next/navigation'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'
import { cn } from '@/lib/utils'

export function AdAnalysisTabNav() {
  const pathname = usePathname()

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max gap-2 rounded-[1.4rem] border border-border/70 bg-card/90 p-2 shadow-[0_14px_36px_-26px_hsl(var(--secondary)/0.25)]">
        {AD_ANALYSIS_TABS.map((tab) => {
          const isActive = pathname === tab.href
          return (
            <RouteLoadingLink
              key={tab.key}
              href={tab.href}
              className={cn(
                'rounded-xl px-4 py-2.5 text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-200',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-[0_12px_26px_-16px_hsl(var(--primary)/0.75)]'
                  : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground'
              )}
            >
              {tab.label}
            </RouteLoadingLink>
          )
        })}
      </div>
    </div>
  )
}
