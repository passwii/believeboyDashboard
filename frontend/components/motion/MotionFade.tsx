'use client'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'
import { DURATION, EASE } from '@/lib/motion/tokens'

type Props = {
  children: ReactNode
  className?: string
} & Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'transition'>

export function MotionFade({ children, className, ...rest }: Props) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION.base, ease: EASE.out }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
