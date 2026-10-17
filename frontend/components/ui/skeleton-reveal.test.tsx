import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SkeletonReveal } from './skeleton-reveal'

describe('SkeletonReveal（transitions.dev 14-skeleton-reveal）', () => {
  it('loading：容器无 is-revealed、data-state=loading、aria-busy，骨架层 aria-hidden', () => {
    render(
      <SkeletonReveal loading skeleton={<div className="h-40" />} data-testid="skel">
        content
      </SkeletonReveal>
    )
    const root = screen.getByTestId('skel')
    expect(root.className).toContain('ui-skel')
    expect(root.className).not.toContain('is-revealed')
    expect(root.getAttribute('data-state')).toBe('loading')
    expect(root.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('skeleton-layer').getAttribute('aria-hidden')).toBe('true')
  })

  /* 契约：globals.css 的 .ui-skel.is-revealed 选择器依赖这两个标记（class + data-state）。
   * 缺任一，交叉揭示就不会发生（骨架不淡出 / 内容不淡入）。 */
  it('revealed：加 is-revealed、data-state=revealed、去掉 aria-busy；骨架层仍在 DOM（交叉揭示的前提）', () => {
    render(
      <SkeletonReveal loading={false} skeleton={<div className="h-40" />} data-testid="skel">
        content
      </SkeletonReveal>
    )
    const root = screen.getByTestId('skel')
    expect(root.className).toContain('is-revealed')
    expect(root.getAttribute('data-state')).toBe('revealed')
    expect(root.hasAttribute('aria-busy')).toBe(false)
    // 与「加载完卸载骨架」旧模式的关键差异：骨架层不卸载
    expect(screen.getByTestId('skeleton-layer')).toBeDefined()
    expect(screen.getByTestId('content-layer').textContent).toBe('content')
  })

  it('两层按 grid 同格叠放（容器高度取较高者，调用方无需给确定高度）', () => {
    render(
      <SkeletonReveal loading skeleton={<div data-testid="sk" />} data-testid="skel">
        <div data-testid="ct" />
      </SkeletonReveal>
    )
    const root = screen.getByTestId('skel')
    expect(root.className).toContain('ui-skel')
    expect(screen.getByTestId('skeleton-layer').className).toContain('ui-skel-skeleton')
    expect(screen.getByTestId('content-layer').className).toContain('ui-skel-content')
  })
})
