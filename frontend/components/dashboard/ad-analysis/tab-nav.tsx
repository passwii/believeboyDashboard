'use client'

import { usePathname, useSearchParams } from 'next/navigation'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'
import { cn } from '@/lib/utils'

/**
 * BLF-818 · 终端风子 Tab 栏（Pattern B 下部数据网格 Tab）：
 * h-8 单行、1px 边界、零圆角零阴影；激活态底部 2px accent 指示条 +
 * 文字提亮，非激活 hover 仅文字变色 —— 无背景位移动画，切换零布局抖动。
 */
export function AdAnalysisTabNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  return (
    <div className="overflow-x-auto term-scroll">
      <nav
        aria-label="广告分析子页面"
        className="flex h-8 min-w-max items-stretch border border-term-border bg-term-panel"
      >
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
              className={cn(
                'relative flex shrink-0 items-center border-r border-term-border px-3 font-mono text-xs tracking-wide transition-colors last:border-r-0',
                isActive
                  ? 'bg-term-raised font-semibold text-term-text'
                  : 'text-term-muted hover:bg-term-hover hover:text-term-text'
              )}
            >
              {tab.label}
              {/* 激活态底部 accent 指示条（2px，绝对定位不占布局空间 → 零抖动） */}
              {isActive ? (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-term-accent"
                />
              ) : null}
            </RouteLoadingLink>
          )
        })}
      </nav>
    </div>
  )
}
