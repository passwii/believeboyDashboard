'use client'

import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

/**
 * Shared visual treatment for the heading's highlighted word — the
 * typewriter's static highlight span and the rolling carousel must look
 * pixel-identical so the typed word can morph into the roller with no
 * visual jump.
 */
export const HIGHLIGHT_WORD_CLASS =
  'inline-block italic bg-gradient-to-b from-[#0ea5e9] via-[#2563eb] to-[#1e40af] dark:from-[#4da5fc] dark:via-[#4da5fc] dark:to-white bg-clip-text text-transparent'

/**
 * RollingWord — vertical slot-machine word carousel.
 *
 * All candidate words stack in a single inline-grid cell; the active one
 * is visible while the rest wait below (opacity 0). Each tick slides the
 * current word out upward and the next one in from below.
 *
 * Why inline-grid stacking (instead of a translated column):
 *   - The container's baseline comes from the first grid item, so the
 *     rolling word stays locked to the surrounding heading text's baseline
 *     even mid-animation (transforms never affect layout).
 *   - Every word is measured independently, so the box is always exactly
 *     one word wide/tall — 2-char CJK words never shift the heading layout.
 *
 * Behavior details:
 *   - Pauses while hovered so users can actually read the current word.
 *   - Honors prefers-reduced-motion (short crossfade instead of sliding).
 *   - Non-visible words are aria-hidden so screen readers only announce
 *     the active word, not the whole stacked list.
 */
export function RollingWord({
  words,
  interval = 2600,
  className = '',
}: {
  words: string[]
  /** Dwell time on each word, in ms. */
  interval?: number
  className?: string
}) {
  const [current, setCurrent] = useState(0)
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(true)
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([])
  const prevRef = useRef(0)
  const reducedRef = useRef(false)

  useEffect(() => {
    reducedRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // Pause the carousel when the browser tab is hidden — prevents the
  // interval from firing while GSAP animations are throttled, which
  // caused overlapping words on tab-switch.
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Advance on a timer; hovering or hidden tab pauses the cycle.
  useEffect(() => {
    if (words.length < 2 || paused || !visible) return
    const t = setInterval(() => setCurrent((c) => (c + 1) % words.length), interval)
    return () => clearInterval(t)
  }, [words.length, interval, paused, visible])

  useGSAP(
    () => {
      const prev = prevRef.current
      prevRef.current = current

      // First run: pin the initial word in place, park the rest below.
      if (prev === current) {
        wordRefs.current.forEach((el, i) => {
          if (el) {
            gsap.set(el, i === current ? { opacity: 1, yPercent: 0 } : { opacity: 0, yPercent: 120 })
          }
        })
        return
      }

      const prevEl = wordRefs.current[prev]
      const curEl = wordRefs.current[current]
      const reduced = reducedRef.current
      const tl = gsap.timeline()
      if (prevEl) {
        tl.to(
          prevEl,
          {
            yPercent: reduced ? 0 : -120,
            opacity: 0,
            duration: reduced ? 0.22 : 0.5,
            ease: 'power3.in',
          },
          0
        )
      }
      if (curEl) {
        tl.fromTo(
          curEl,
          { yPercent: reduced ? 0 : 120, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: reduced ? 0.22 : 0.55, ease: 'power3.out' },
          reduced ? 0.08 : 0.1
        )
      }
    },
    [current]
  )

  return (
    <span
      className={`inline-grid overflow-hidden align-baseline ${className}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {words.map((word, i) => (
        <span
          key={word}
          ref={(el) => {
            wordRefs.current[i] = el
          }}
          aria-hidden={i === current ? undefined : true}
          className={`${HIGHLIGHT_WORD_CLASS} [grid-area:1/1]`}
          style={{ opacity: i === 0 ? 1 : 0 }}
        >
          {word}
        </span>
      ))}
    </span>
  )
}
