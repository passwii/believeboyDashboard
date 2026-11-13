'use client'

import React from 'react'
import { LoginBrandPanel } from './login-brand-panel'
import SignInCard from './sign-in-card'
import './login.css'

export function LoginEntry() {
  return (
    <div className="login-entry">
      <main id="main-content" className="smoke-stage">
        <div className="smoke-backdrop" aria-hidden="true">
          <p className="bg-type">BelieveBoy</p>
          <div className="bg-grid" />
          <div className="accent-field" />
          <div className="stage-grain" />
        </div>
        <div className="frame">
          <div className="login-slab">
            <LoginBrandPanel />
            <SignInCard />
          </div>
          <p className="frame-caption mono" aria-hidden="true">BELIEVEBOY / WORKSPACE ACCESS</p>
        </div>
      </main>
    </div>
  )
}
