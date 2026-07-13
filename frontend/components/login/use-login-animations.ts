'use client'

import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

// Module-scope registration guard — avoids double-registration in React Strict Mode
let pluginsRegistered = false
if (typeof window !== 'undefined' && !pluginsRegistered) {
  gsap.registerPlugin(useGSAP)
  pluginsRegistered = true
}

export function useLoginAnimations(containerRef: React.RefObject<HTMLDivElement | null>) {
  const tlRef = useRef<gsap.core.Timeline | null>(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      // Reduced motion: skip all animations, show everything immediately
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(
          '.login-card, .left-brand-logo, .left-brand-title, .left-brand-subtitle, .right-heading, .right-subheading, .login-form-field, .login-btn, .dot-map-canvas',
          { autoAlpha: 1, clearProps: 'transform,rotation,rotationX,rotationY,skewX,scale' }
        )
      })

      // Full animation timeline
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })

        // t=0: Card entrance — fade in with subtle 3D tilt
        tl.fromTo(
          '.login-card',
          { autoAlpha: 0, scale: 0.92, rotationX: 4 },
          { autoAlpha: 1, scale: 1, rotationX: 0, duration: 0.7, ease: 'power3.out' },
          0
        )

        // t=0.25: Logo — spin in with overshoot
        tl.fromTo(
          '.left-brand-logo',
          { autoAlpha: 0, scale: 0, rotation: -180 },
          { autoAlpha: 1, scale: 1, rotation: 0, duration: 0.5, ease: 'back.out(1.7)' },
          0.25
        )

        // t=0.40: Left title — slide down with skew
        tl.fromTo(
          '.left-brand-title',
          { autoAlpha: 0, y: -24, skewX: -3 },
          { autoAlpha: 1, y: 0, skewX: 0, duration: 0.45, ease: 'power3.out' },
          0.4
        )

        // t=0.55: Left subtitle
        tl.fromTo(
          '.left-brand-subtitle',
          { autoAlpha: 0, y: -16 },
          { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' },
          0.55
        )

        // t=0.50: Canvas reveal
        tl.fromTo(
          '.dot-map-canvas',
          { autoAlpha: 0 },
          { autoAlpha: 0.4, duration: 1.0, ease: 'power1.inOut' },
          0.5
        )

        // t=0.35: Right heading — slide from left with 3D rotationY
        tl.fromTo(
          '.right-heading',
          { autoAlpha: 0, x: -20, rotationY: -5 },
          { autoAlpha: 1, x: 0, rotationY: 0, duration: 0.5, ease: 'power3.out' },
          0.35
        )

        // t=0.45: Right subheading
        tl.fromTo(
          '.right-subheading',
          { autoAlpha: 0, x: -12 },
          { autoAlpha: 1, x: 0, duration: 0.4, ease: 'power2.out' },
          0.45
        )

        // t=0.55: Form fields stagger in
        const formFields = gsap.utils.toArray<HTMLElement>('.login-form-field')
        if (formFields.length) {
          tl.fromTo(
            formFields,
            { autoAlpha: 0, y: 20, scale: 0.97 },
            {
              autoAlpha: 1,
              y: 0,
              scale: 1,
              duration: 0.4,
              ease: 'power2.out',
              stagger: 0.08,
            },
            0.55
          )
        }

        // t=0.90: Button elastic settle
        tl.fromTo(
          '.login-btn',
          { scale: 0.97 },
          { scale: 1, duration: 0.3, ease: 'elastic.out(1, 0.5)' },
          0.9
        )

        tlRef.current = tl
      })

      return () => {
        mm.revert()
      }
    },
    { scope: containerRef }
  )

  return { timeline: tlRef }
}
