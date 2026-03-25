'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'

type Props = {
  children: ReactNode
}

const TAB_INDEX = new Map(AD_ANALYSIS_TABS.map((tab, index) => [tab.href, index]))

function resolveDirection(previousPathname: string, currentPathname: string) {
  const previousIndex = TAB_INDEX.get(previousPathname)
  const currentIndex = TAB_INDEX.get(currentPathname)

  if (previousIndex == null || currentIndex == null || previousIndex === currentIndex) {
    return 0
  }

  return currentIndex > previousIndex ? 1 : -1
}

export function AdAnalysisPageTransition({ children }: Props) {
  const pathname = usePathname()
  const prefersReducedMotion = useReducedMotion()
  const previousPathnameRef = useRef(pathname)
  const [direction, setDirection] = useState(0)

  useEffect(() => {
    const previousPathname = previousPathnameRef.current
    setDirection(resolveDirection(previousPathname, pathname))
    previousPathnameRef.current = pathname
  }, [pathname])

  const initialState = prefersReducedMotion
    ? { opacity: 1 }
    : {
        opacity: 0,
        x: direction === 0 ? 0 : direction * 20,
        y: 10,
        filter: 'blur(6px)',
      }

  const animateState = {
    opacity: 1,
    x: 0,
    y: 0,
    filter: 'blur(0px)',
  }

  const exitState = prefersReducedMotion
    ? { opacity: 1 }
    : {
        opacity: 0,
        x: direction === 0 ? 0 : direction * -14,
        y: -6,
        filter: 'blur(4px)',
      }

  return (
    <div className="relative overflow-x-clip">
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={pathname}
          initial={initialState}
          animate={animateState}
          exit={exitState}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : {
                  duration: 0.26,
                  ease: [0.22, 1, 0.36, 1],
                }
          }
          className="will-change-transform"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
