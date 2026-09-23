'use client'

import React from 'react'
import { LoginBrandPanel } from './login-brand-panel'
import SignInCard from './sign-in-card'

export function LoginEntry() {
  return (
    <main className="min-h-dvh bg-term-bg text-term-text md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
      <div className="hidden md:block">
        <LoginBrandPanel />
      </div>
      <SignInCard />
    </main>
  )
}
