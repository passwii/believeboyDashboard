'use client'

import React, { useEffect, useRef } from 'react'
import { BrandMark } from './brand-mark'

export function LoginBrandPanel() {
  const artRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const art = artRef.current
    if (!art || !('IntersectionObserver' in window)) return
    let visible = false
    const updateMotion = () => art.classList.toggle('is-paused', !visible || document.hidden)
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      updateMotion()
    }, { threshold: 0.05 })
    observer.observe(art)
    document.addEventListener('visibilitychange', updateMotion)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', updateMotion)
    }
  }, [])

  return (
    <section className="brand-panel" aria-labelledby="login-brand-title">
      <div className="brand-head" aria-label="BelieveBoy">
        <span className="brand-mark"><BrandMark /></span>
        <span className="wordmark">BelieveBoy</span>
      </div>
      <div className="brand-kicker mono">Cross-border operations</div>
      <div className="route-art" ref={artRef} aria-hidden="true">
        <svg viewBox="0 0 680 430" role="presentation">
          <path className="route-wire" d="M78 83H220V145H292V205M388 255H474V320H612" />
          <path className="route-wire" d="M106 350H210V306H292V275M388 205H474V145H578V92" />
          <path className="route-wire-live" d="M78 83H220V145H292V205M388 255H474V320H612" />
          <path className="route-wire-live" d="M106 350H210V306H292V275M388 205H474V145H578V92" />
          <rect className="route-node" x="71" y="76" width="14" height="14" />
          <rect className="route-node-core" x="76" y="81" width="4" height="4" />
          <rect className="route-node" x="605" y="85" width="14" height="14" />
          <rect className="route-node-core" x="610" y="90" width="4" height="4" />
          <rect className="route-node" x="99" y="343" width="14" height="14" />
          <rect className="route-node-core" x="104" y="348" width="4" height="4" />
          <rect className="route-hub" x="292" y="205" width="96" height="96" />
          <svg x="310" y="223" width="60" height="60" viewBox="0 0 64 64"><BrandMark /></svg>
          <rect className="route-corner" x="289" y="202" width="5" height="5" />
          <rect className="route-corner" x="386" y="299" width="5" height="5" />
        </svg>
      </div>
      <div className="brand-copy">
        <h1 id="login-brand-title">跨境电商<br />运营工作区</h1>
        <p>把日常运营与数据，集中在一个工作区。</p>
      </div>
      <footer className="brand-foot">
        <span>彼励扶跨境 · BelieveBoy</span>
        <span className="mono">A PLACE FOR DAILY WORK</span>
      </footer>
    </section>
  )
}
