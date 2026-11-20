'use client'

import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

export function StatusBackButton({ children = '返回上一页' }: { children?: ReactNode }) {
  return (
    <WarmButton variant="secondary" onClick={() => window.history.back()}>
      <ArrowLeft className="h-4 w-4" />
      {children}
    </WarmButton>
  )
}
