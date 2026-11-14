'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'
import { cn } from '@/lib/utils'
import styles from '@/app/dashboard/advertising/ad-analysis/ad-analysis-warm.module.css'

/**
 * BLF-818 · V4 Warm Ledger 子 Tab 栏：
 * 单行控件带 Warm 面板/描边/圆角；激活态底部 2px accent 指示条 +
 * 文字提亮，非激活 hover 仅背景轻微增强 —— 切换零布局抖动。
 */
export function AdAnalysisTabNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    const active = scroller?.querySelector<HTMLElement>('[data-ad-tab-active="true"]')
    if (!scroller || !active) return

    const scrollerRect = scroller.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    if (activeRect.left >= scrollerRect.left && activeRect.right <= scrollerRect.right) return

    scroller.scrollLeft += activeRect.left - scrollerRect.left - 8
  }, [pathname])

  return (
    <div ref={scrollerRef} className={styles.tabScroller}>
      <nav aria-label="广告分析子页面" className={styles.tabNav} data-warm-tablist="true">
        {AD_ANALYSIS_TABS.map((tab) => {
          const isActive = pathname === tab.href
          const href = searchParams.toString()
            ? `${tab.href}?${searchParams.toString()}`
            : tab.href
          return (
            <RouteLoadingLink
              key={tab.key}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              data-ad-tab-active={isActive ? 'true' : undefined}
              className={cn(styles.tabLink, isActive && styles.tabLinkActive)}
            >
              {tab.label}
              {/* 激活态底部 accent 指示条（2px，绝对定位不占布局空间 → 零抖动） */}
              {isActive ? (
                <span
                  aria-hidden
                  className={styles.tabIndicator}
                />
              ) : null}
            </RouteLoadingLink>
          )
        })}
      </nav>
    </div>
  )
}
