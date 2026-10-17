'use client'

import { cn } from '@/lib/utils'
import React from 'react'

interface RefreshProgressBarProps {
  /** Show the progress bar while keeping the content readable and interactive */
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
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-term-raised"
        >
          <div
            data-testid="refresh-progress-indicator"
            className="h-full w-1/3 bg-term-accent animate-shimmer motion-reduce:w-full motion-reduce:animate-none"
          />
        </div>
      )}
      <Component
        aria-busy={refreshing}
        data-testid="refresh-progress-region"
        className={cn('transition-colors duration-200', className)}
      >
        {children}
      </Component>
    </>
  )
}
