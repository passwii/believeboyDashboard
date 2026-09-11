'use client'

import * as React from 'react'

/**
 * useInsightFollowBottom — 流式内容的「跟随底部」策略（BLF-1013）。
 *
 * 规则：
 * - 用户在底部附近（默认 48px 内）时，新内容到达后自动贴底；
 * - 用户上移阅读时不再强制滚底，只标记 `hasNewContent`，由 UI 给出「有新内容」入口；
 * - 每个 delta 都即时贴底而不是动画滚动，避免长文抖动；
 *   用户主动点「有新内容」时才按 reduced-motion 决定是否平滑滚动。
 *
 * `signal` 是内容变化的观测点（通常是当前草稿字符串），变化即视为「有新内容」。
 */
const DEFAULT_THRESHOLD_PX = 48

export type InsightFollowBottomResult = {
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  isFollowing: boolean
  hasNewContent: boolean
  scrollToBottom: () => void
}

export type UseInsightFollowBottomOptions = {
  signal: unknown
  thresholdPx?: number
  reducedMotion?: boolean
}

export function useInsightFollowBottom({
  signal,
  thresholdPx = DEFAULT_THRESHOLD_PX,
  reducedMotion = false,
}: UseInsightFollowBottomOptions): InsightFollowBottomResult {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [isFollowing, setIsFollowing] = React.useState(true)
  const [hasNewContent, setHasNewContent] = React.useState(false)
  const isFollowingRef = React.useRef(true)

  React.useEffect(() => {
    const node = containerRef.current
    if (!node) return

    const handleScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      const nearBottom = distance <= thresholdPx
      isFollowingRef.current = nearBottom
      setIsFollowing(nearBottom)
      if (nearBottom) setHasNewContent(false)
    }

    node.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => node.removeEventListener('scroll', handleScroll)
  }, [thresholdPx])

  React.useEffect(() => {
    const node = containerRef.current
    if (!node) return

    if (!isFollowingRef.current) {
      setHasNewContent(true)
      return
    }
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' })
  }, [signal])

  const scrollToBottom = React.useCallback(() => {
    isFollowingRef.current = true
    setIsFollowing(true)
    setHasNewContent(false)
    const node = containerRef.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [reducedMotion])

  return { containerRef, isFollowing, hasNewContent, scrollToBottom }
}
