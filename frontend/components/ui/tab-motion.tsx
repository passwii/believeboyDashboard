'use client'

import { Fragment, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { DURATION, EASE } from '@/lib/motion/tokens'

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
                  duration: DURATION.fast,
                  ease: EASE.smoothOut,
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
  const isWarm = variant === 'warm'

  return (
    <TabsTrigger
      value={value}
      variant={variant}
      className={cn(
        'relative isolate overflow-hidden',
        isTerm
          ? 'data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:after:hidden'
          : isWarm
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
                    /* transitions.dev 16-tabs-sliding：滑块位移走 250ms smooth-out
                     * （--tabs-dur / --tabs-ease），不再用自定义 spring。
                     * snippet 的 --tabs-* 颜色 token 是浅色主题字面值，与本仓库的
                     * term 令牌色彩体系冲突，不接入（只取运动规格）。 */
                    layout: { duration: DURATION.fast, ease: EASE.smoothOut },
                    opacity: { duration: DURATION.quick, ease: EASE.smoothOut },
                  }
            }
            className={cn(
              'absolute inset-0 border shadow-none',
              isWarm ? 'z-0' : '-z-10',
              isTerm
                ? 'rounded-none border-transparent bg-term-raised after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-term-accent after:shadow-[0_0_8px_color-mix(in_srgb,var(--term-accent)_60%,transparent),0_0_16px_color-mix(in_srgb,var(--term-accent)_30%,transparent)]'
                : isWarm
                  ? 'rounded-[inherit] border border-[var(--warm-ledger-color-hairline-strong)] bg-[var(--warm-ledger-color-raised)] shadow-[var(--warm-ledger-highlight-rest)]'
                  : // BLF-893：非 term 分支的暗主题边框改走 term-border-strong（与 isTerm 路径基线对齐）。
                    'rounded-[inherit] border-term-border-strong bg-term-raised'
            )}
          />
        ) : null}
      </AnimatePresence>
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </TabsTrigger>
  )
}
