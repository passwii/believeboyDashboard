'use client'

import type { ReactNode } from 'react'

import {
  useMobileFilterStrip,
  usePrimaryFilterSlot,
  useSecondaryHeaderSlot,
} from '@/components/terminal/terminal-header-slot'

type DailyAnalysisHeaderSlotsProps = {
  isMobile: boolean
  primaryControls: ReactNode
  secondaryControls: ReactNode
  mobileControls: ReactNode
}

/** Routes daily-analysis filters to the existing mobile strip or the two desktop header rows. */
export function DailyAnalysisHeaderSlots({
  isMobile,
  primaryControls,
  secondaryControls,
  mobileControls,
}: DailyAnalysisHeaderSlotsProps) {
  const primaryPortal = usePrimaryFilterSlot(isMobile ? null : primaryControls)
  const secondaryPortal = useSecondaryHeaderSlot(isMobile ? null : secondaryControls)
  const mobilePortal = useMobileFilterStrip(mobileControls)

  return (
    <>
      {primaryPortal}
      {secondaryPortal}
      {mobilePortal}
    </>
  )
}
