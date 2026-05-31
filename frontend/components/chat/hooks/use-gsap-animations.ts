'use client'

import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin()

/**
 * GSAP animation utilities for the AI Chat component.
 * All animations respect prefers-reduced-motion.
 */
export function useChatAnimations(scopeRef: React.RefObject<HTMLElement | null>) {
  const ctx = useRef<gsap.Context | null>(null)

  useGSAP(
    () => {
      ctx.current = gsap.context(() => {}, scopeRef)
    },
    { scope: scopeRef }
  )

  const prefersReducedMotion = useRef(
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )

  // Sidebar slide in
  const animateSidebarIn = (el: HTMLElement) => {
    if (prefersReducedMotion.current) {
      gsap.set(el, { opacity: 1, x: 0 })
      return
    }
    gsap.fromTo(
      el,
      { opacity: 0, x: -280 },
      { opacity: 1, x: 0, duration: 0.35, ease: 'power3.out' }
    )
  }

  // Message entrance with stagger
  const animateMessageEntrance = (els: HTMLElement[]) => {
    if (prefersReducedMotion.current) {
      gsap.set(els, { opacity: 1, y: 0 })
      return
    }
    gsap.fromTo(
      els,
      { opacity: 0, y: 16 },
      {
        opacity: 1,
        y: 0,
        duration: 0.4,
        ease: 'power3.out',
        stagger: 0.06,
      }
    )
  }

  // Stop button pop in
  const animateStopButtonIn = (el: HTMLElement) => {
    if (prefersReducedMotion.current) {
      gsap.set(el, { opacity: 1, scale: 1 })
      return
    }
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.8, y: 8 },
      { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(2)' }
    )
  }

  // Stop button fade out
  const animateStopButtonOut = (el: HTMLElement, onComplete?: () => void) => {
    if (prefersReducedMotion.current) {
      gsap.set(el, { opacity: 0 })
      onComplete?.()
      return
    }
    gsap.to(el, {
      opacity: 0,
      scale: 0.9,
      y: -8,
      duration: 0.2,
      ease: 'power2.in',
      onComplete,
    })
  }

  // Input focus glow
  const animateInputFocus = (el: HTMLElement, focused: boolean) => {
    gsap.to(el, {
      opacity: focused ? 1 : 0,
      scale: focused ? 1 : 0.95,
      duration: 0.3,
      ease: 'power2.out',
    })
  }

  // Model selector dropdown
  const animateDropdownIn = (el: HTMLElement) => {
    if (prefersReducedMotion.current) {
      gsap.set(el, { opacity: 1, scale: 1, y: 0 })
      return
    }
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.92, y: 8 },
      { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(1.7)' }
    )
  }

  // Conversation item hover
  const animateConvItemHover = (el: HTMLElement, isHovered: boolean) => {
    gsap.to(el, {
      x: isHovered ? 2 : 0,
      backgroundColor: isHovered
        ? 'rgba(255,255,255,0.04)'
        : 'rgba(255,255,255,0)',
      duration: 0.2,
      ease: 'none',
    })
  }

  // Send button press feedback
  const animateSendPress = (el: HTMLElement) => {
    if (prefersReducedMotion.current) return
    gsap.fromTo(
      el,
      { scale: 0.92 },
      { scale: 1, duration: 0.3, ease: 'back.out(3)' }
    )
  }

  return {
    animateSidebarIn,
    animateMessageEntrance,
    animateStopButtonIn,
    animateStopButtonOut,
    animateInputFocus,
    animateDropdownIn,
    animateConvItemHover,
    animateSendPress,
  }
}
