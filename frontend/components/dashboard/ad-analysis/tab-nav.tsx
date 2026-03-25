'use client'

import { LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'
import { cn } from '@/lib/utils'

export function AdAnalysisTabNav() {
  const pathname = usePathname()
  const prefersReducedMotion = useReducedMotion()

  return (
    <div className="overflow-x-auto">
      <LayoutGroup id="ad-analysis-tabs">
        <div className="flex min-w-max gap-2 rounded-lg border border-border/70 bg-[hsl(var(--surface-overlay)/0.94)] p-2 shadow-[var(--shadow-soft)] dark:border-border/85 dark:bg-[hsl(var(--surface-panel)/0.96)]">
          {AD_ANALYSIS_TABS.map((tab) => {
            const isActive = pathname === tab.href
            return (
              <RouteLoadingLink
                key={tab.key}
                href={tab.href}
                className={cn(
                  'relative isolate rounded-md px-4 py-2.5 text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-200 ease-[var(--motion-ease-out)]',
                  isActive
                    ? '-translate-y-px text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground dark:text-foreground/72 dark:hover:bg-[hsl(var(--surface-strong))] dark:hover:text-foreground'
                )}
              >
                {isActive ? (
                  <motion.span
                    layoutId="ad-analysis-active-tab"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : {
                            type: 'spring',
                            stiffness: 360,
                            damping: 34,
                            mass: 0.7,
                          }
                    }
                    className="absolute inset-0 -z-10 rounded-md bg-primary shadow-[0_12px_26px_-16px_hsl(var(--primary)/0.75)]"
                  />
                ) : null}
                <span className="relative z-10">{tab.label}</span>
              </RouteLoadingLink>
            )
          })}
        </div>
      </LayoutGroup>
    </div>
  )
}
