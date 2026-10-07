'use client'

import React from 'react'
import { LoginBrandPanel } from './login-brand-panel'
import { LoginThemeToggle } from './login-theme-toggle'
import { BrandMark } from './brand-mark'
import SignInCard from './sign-in-card'
import './login.css'

export function LoginEntry() {
  return (
    <div className="login-entry">
      <header className="topbar">
        <div className="identity" aria-label="BelieveBoy">
          <span className="brand-mark"><BrandMark /></span>
          <span className="wordmark">BelieveBoy</span>
        </div>
        <div className="topbar-right">
          <span className="topbar-note mono">BELIEVEBOY / WORKSPACE ACCESS</span>
          <LoginThemeToggle />
        </div>
      </header>
      <main id="main-content" className="layout">
        <LoginBrandPanel />
        <SignInCard />
      </main>
    </div>
  )
}
