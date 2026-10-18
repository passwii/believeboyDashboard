import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

import { DeferredSection } from '@/components/dashboard/deferred-section'

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  callback: ObserverCallback
  observed: Element[] = []
  disconnected = false

  constructor(callback: ObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }

  observe(el: Element) {
    this.observed.push(el)
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true
  }

  takeRecords() {
    return []
  }

  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting }])
  }
}

function SelfFetchingChild() {
  // 模拟 mount 即拉数的组件：mount 次数即请求次数
  return <div data-testid="child">child-mounted</div>
}

describe('DeferredSection', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('进入视口前只渲染骨架、不挂载子组件（子组件的 mount-fetch 被推迟）', () => {
    render(
      <DeferredSection data-testid="deferred">
        <SelfFetchingChild />
      </DeferredSection>
    )
    expect(screen.queryByTestId('child')).toBeNull()
    // 默认 fallback 是 transitions.dev 14 的脉冲骨架层（不再用扫光底）
    const container = screen.getByTestId('deferred')
    expect(container.querySelector('.ui-skel-skeleton')).not.toBeNull()
    expect(container.querySelector('.ui-skel')?.getAttribute('data-state')).toBe('loading')
  })

  it('进入视口后挂载子组件，骨架层转入已揭示态（不卸载）', () => {
    render(
      <DeferredSection data-testid="deferred">
        <SelfFetchingChild />
      </DeferredSection>
    )
    const observer = MockIntersectionObserver.instances[0]
    act(() => observer.trigger(true))
    expect(screen.getByTestId('child').textContent).toBe('child-mounted')
    const deferred = screen.getByTestId('deferred')
    const root = deferred.querySelector('.ui-skel')
    expect(root?.className).toContain('is-revealed')
    expect(root?.getAttribute('data-state')).toBe('revealed')
    // 与「加载完卸载骨架」旧模式的差异：骨架层保留在 DOM（交叉揭示前提）
    expect(deferred.querySelector('.ui-skel-skeleton')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('支持自定义 fallback', () => {
    render(
      <DeferredSection data-testid="deferred" fallback={<div data-testid="custom-fallback" />}>
        <SelfFetchingChild />
      </DeferredSection>
    )
    expect(screen.getByTestId('custom-fallback')).toBeDefined()
    expect(screen.queryByTestId('child')).toBeNull()
  })
})
