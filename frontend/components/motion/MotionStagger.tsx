'use client'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'
import { DURATION, EASE, STAGGER } from '@/lib/motion/tokens'

type ContainerProps = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'variants' | 'transition'>

export function MotionStagger({ children, className, ...rest }: ContainerProps) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: STAGGER.childDelay, delayChildren: 0.02 } },
      }}
      className={className}
      {...rest}
    >
      {reduce ? <>{children}</> : children}
    </motion.div>
  )
}

type ItemProps = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'variants' | 'transition'>

export function MotionStaggerItem({ children, className, ...rest }: ItemProps) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.out } },
      }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
