'use client'

import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function StatusRetryButton({
  onClick,
  children = '重新加载',
}: {
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <Button variant="outline" onClick={onClick}>
      <RotateCcw className="h-4 w-4" />
      {children}
    </Button>
  )
}
