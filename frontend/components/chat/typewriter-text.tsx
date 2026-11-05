'use client'

import React from 'react'
import type { TextSegment } from './types'
import { useTypewriter } from './hooks/use-typewriter'
import { RollingWord, HIGHLIGHT_WORD_CLASS } from './rolling-word'
import styles from './warm-chat.module.css'

export function TypewriterText({
  segments,
  startDelay = 0,
  className = '',
  rollingWords,
}: {
  segments: TextSegment[]
  startDelay?: number
  className?: string
  /**
   * Optional word carousel for the highlighted segment. Once typing
   * finishes, the highlighted word morphs into a vertical roller that
   * cycles through these words (`rollingWords[0]` should match the
   * highlighted segment's `text` — the word that gets typed first).
   */
  rollingWords?: string[]
}) {
  const { segIdx, charIdx, done, started } = useTypewriter(segments, startDelay)
  const showCursor = started && !done
  const rollerReady = done && !!rollingWords && rollingWords.length > 1

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (i > segIdx) return null
        const visibleChars = i < segIdx ? seg.text.length : charIdx
        const visible = seg.text.slice(0, visibleChars)

        if (seg.highlight) {
          // Typing finished → the highlighted word becomes a rolling carousel.
          if (rollerReady) {
            return <RollingWord key={i} words={rollingWords!} className="px-2 mx-0.5" />
          }
          if (!visible) return null
          return (
            <span key={i} className={`${HIGHLIGHT_WORD_CLASS} px-2 mx-0.5`}>
              {visible}
            </span>
          )
        }

        if (!visible) return null
        return <React.Fragment key={i}>{visible}</React.Fragment>
      })}
      {showCursor && (
        <span
          className={`${styles.cursor} bb-cursor-blink`}
          aria-hidden
        />
      )}
    </span>
  )
}
