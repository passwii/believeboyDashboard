'use client'

import { Suspense } from 'react'
import Index from '@/components/login'

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Index />
    </Suspense>
  )
}
