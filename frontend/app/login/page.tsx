'use client'

import { Suspense } from 'react'
import Index from '@/components/ui/bilifu-crossborder-signin'

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Index />
    </Suspense>
  )
}
