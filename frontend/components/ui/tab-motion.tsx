'use client'

import { Fragment, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

export function TabsMotionGroup({ id, children }: { id: string; children: ReactNode }) {
  void id
  return <Fragment>{children}</Fragment>
}

export function DirectionalTabTransition({
  value,
  order,
  children,
  className,
}: {
  value: string
  order: readonly string[]
  children: ReactNode
  className?: string
}) {
  const prefersReducedMotion = useReducedMotion()
  void order

  return (
    <div className={cn('relative flex-1 min-h-0 overflow-x-clip', className)}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={value}
          initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : {
                  duration: 0.2,
                  ease: [0.22, 1, 0.36, 1],
                }
          }
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

type SlidingTabsTriggerProps = ComponentPropsWithoutRef<typeof TabsTrigger> & {
  activeValue: string
  layoutId: string
}

export function SlidingTabsTrigger({
  activeValue,
  layoutId,
  value,
  variant,
  className,
  children,
  ...props
}: SlidingTabsTriggerProps) {
  const prefersReducedMotion = useReducedMotion()
  const isActive = activeValue === value
  const isTerm = variant === 'term'

  return (
    <TabsTrigger
      value={value}
      variant={variant}
      className={cn(
        'relative isolate overflow-hidden',
        isTerm
          ? 'data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none'
          : 'data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none',
        className
      )}
      {...props}
    >
      <AnimatePresence initial={false}>
        {isActive ? (
          <motion.span
            key="active-fill"
            layoutId={layoutId}
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
            transition={
              prefersReducedMotion
                ? { duration: 0 }
                : {
                    layout: { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 },
                    opacity: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
                  }
            }
            className={cn(
              'absolute inset-0 -z-10 border shadow-none',
              isTerm
                ? 'rounded-none border-term-border-strong bg-term-raised'
                : 'rounded-[inherit] border-term-border-strong bg-term-raised [.dark_&]:border-[hsl(var(--surface-high))]'
            )}
          />
        ) : null}
      </AnimatePresence>
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </TabsTrigger>
  )
}
