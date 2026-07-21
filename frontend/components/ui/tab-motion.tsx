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
  className,
  children,
  ...props
}: SlidingTabsTriggerProps) {
  const prefersReducedMotion = useReducedMotion()
  const isActive = activeValue === value

  return (
    <TabsTrigger
      value={value}
      className={cn(
        'relative isolate overflow-hidden data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none',
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
            className="absolute inset-0 -z-10 rounded-[inherit] border border-[hsl(0_0%_100%/0.96)] bg-[linear-gradient(180deg,hsl(0_0%_100%/1),hsl(210_20%_99%/1))] shadow-[0_1px_0_hsl(0_0%_100%/1),0_10px_22px_-14px_rgba(15,23,42,0.18),0_2px_6px_rgba(15,23,42,0.06)] dark:border-[hsl(var(--surface-high))] dark:bg-[linear-gradient(180deg,hsl(var(--surface-high)/0.95),hsl(var(--surface-elevated)/0.98))] dark:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_0_24px_-8px_hsl(var(--primary)/0.45),0_0_48px_-16px_hsl(var(--primary)/0.25),0_4px_12px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_hsl(var(--surface-bright)/0.12)]"
          />
        ) : null}
      </AnimatePresence>
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </TabsTrigger>
  )
}
