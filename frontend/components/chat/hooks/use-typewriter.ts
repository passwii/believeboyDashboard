import { useState, useEffect } from 'react'
import type { TextSegment } from '../types'

export function useTypewriter(segments: TextSegment[], startDelay = 0) {
  const [state, setState] = useState({ segIdx: 0, charIdx: 0, done: false })
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), startDelay)
    return () => clearTimeout(timer)
  }, [startDelay])

  useEffect(() => {
    if (!started || state.done) return

    if (state.segIdx >= segments.length) {
      setState(s => ({ ...s, done: true }))
      return
    }

    const seg = segments[state.segIdx]
    if (state.charIdx >= seg.text.length) {
      const t = setTimeout(() => {
        setState(s => ({ segIdx: s.segIdx + 1, charIdx: 0, done: false }))
      }, 120)
      return () => clearTimeout(t)
    }

    const t = setTimeout(() => {
      setState(s => ({ ...s, charIdx: s.charIdx + 1 }))
    }, seg.speed)
    return () => clearTimeout(t)
  }, [started, state.segIdx, state.charIdx, state.done, segments])

  return { ...state, started }
}
