'use client'

import { cn } from '@/lib/utils'

interface RefreshProgressBarProps {
  /** Show the progress bar and dim content */
  refreshing: boolean
  /** Additional class names for the dimming wrapper */
  className?: string
  /** The content to wrap */
  children: React.ReactNode
}

/**
 * Wraps content with a subtle shimmer progress bar + opacity dim when refreshing.
 * The parent container should be `relative` for the progress bar to position correctly.
 *
 * Usage:
 * ```tsx
 * <div className="relative flex-1">
 *   <RefreshProgressBar refreshing={isRefreshing}>
 *     <MyTable data={rows} />
 *   </RefreshProgressBar>
 * </div>
 * ```
 */
export function RefreshProgressBar({ refreshing, className, children }: RefreshProgressBarProps) {
  return (
    <>
      {refreshing && (
        <div className='absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-blue-100 dark:bg-blue-900/30'>
          <div className='h-full w-1/3 bg-blue-500 animate-shimmer' />
        </div>
      )}
      <div
        className={cn(
          'transition-opacity duration-200',
          refreshing && 'opacity-50 pointer-events-none',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
