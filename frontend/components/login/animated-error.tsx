'use client'

import React, { useRef, useState, useEffect } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

interface AnimatedErrorProps {
  message: string | null
}

const AnimatedError = ({ message }: AnimatedErrorProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [renderContent, setRenderContent] = useState<string | null>(null)
  const animatingOut = useRef(false)

  useEffect(() => {
    if (message) {
      // New error — show immediately, then animate in
      animatingOut.current = false
      setRenderContent(message)
    } else if (renderContent && !animatingOut.current) {
      // Error cleared — animate out, then remove from DOM
      animatingOut.current = true
      const el = containerRef.current
      if (el) {
        gsap.to(el, {
          autoAlpha: 0,
          y: -6,
          scale: 0.97,
          duration: 0.25,
          ease: 'power2.in',
          onComplete: () => {
            setRenderContent(null)
            animatingOut.current = false
          },
        })
      } else {
        setRenderContent(null)
      }
    }
  }, [message])

  // Animate in when renderContent is set and message is truthy
  useGSAP(
    () => {
      if (message && containerRef.current) {
        gsap.fromTo(
          containerRef.current,
          { autoAlpha: 0, y: 8, scale: 0.97 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: 'power2.out' }
        )
      }
    },
    { dependencies: [renderContent, message] }
  )

  if (!renderContent) return null

  return (
    <div
      ref={containerRef}
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400"
    >
      {renderContent}
    </div>
  )
}

export default AnimatedError
