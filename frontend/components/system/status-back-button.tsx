'use client'

import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function StatusBackButton({ children = '返回上一页' }: { children?: ReactNode }) {
  return (
    <Button variant="outline" onClick={() => window.history.back()}>
      <ArrowLeft className="h-4 w-4" />
      {children}
    </Button>
  )
}
