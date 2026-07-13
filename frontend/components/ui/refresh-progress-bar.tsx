'use client'

import { cn } from '@/lib/utils'
import React from 'react'

interface RefreshProgressBarProps {
  /** Show the progress bar and dim content */
  refreshing: boolean
  /** Additional class names for the dimming wrapper */
  className?: string
  /** The content to wrap */
  children: React.ReactNode
  /** Wrapper element type (default: 'div'). Use 'tbody' when inside <table>. */
  as?: React.ElementType
}

export function RefreshProgressBar({
  refreshing,
  className,
  children,
  as: Component = 'div',
}: RefreshProgressBarProps) {
  return (
    <>
      {refreshing && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-blue-100 dark:bg-blue-900/30">
          <div className="h-full w-1/3 bg-blue-500 animate-shimmer" />
        </div>
      )}
      <Component
        className={cn(
          'transition-opacity duration-200',
          refreshing && 'opacity-50 pointer-events-none',
          className
        )}
      >
        {children}
      </Component>
    </>
  )
}
