'use client'

import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

export function StatusRetryButton({
  onClick,
  children = '重新加载',
}: {
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <WarmButton variant="secondary" onClick={onClick}>
      <RotateCcw className="h-4 w-4" />
      {children}
    </WarmButton>
  )
}
