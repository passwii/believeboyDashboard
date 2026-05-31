'use client'

import React from 'react'
import type { TextSegment } from './types'
import { useTypewriter } from './hooks/use-typewriter'

export function TypewriterText({
  segments,
  startDelay = 0,
  className = '',
}: {
  segments: TextSegment[]
  startDelay?: number
  className?: string
}) {
  const { segIdx, charIdx, done, started } = useTypewriter(segments, startDelay)
  const showCursor = started && !done

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (i > segIdx) return null
        const visibleChars = i < segIdx ? seg.text.length : charIdx
        const visible = seg.text.slice(0, visibleChars)
        if (!visible) return null

        return seg.highlight ? (
          <span
            key={i}
            className="inline-block italic bg-gradient-to-b from-[#4da5fc] via-[#4da5fc] to-white bg-clip-text text-transparent px-1.5"
          >
            {visible}
          </span>
        ) : (
          <React.Fragment key={i}>{visible}</React.Fragment>
        )
      })}
      {showCursor && (
        <span
          className="inline-block w-[3px] h-[0.8em] bg-blue-400/80 ml-0.5 align-middle bb-cursor-blink"
          aria-hidden
        />
      )}
    </span>
  )
}
