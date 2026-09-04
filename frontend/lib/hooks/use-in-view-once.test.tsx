import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

import { useInViewOnce } from '@/lib/hooks/use-in-view-once'

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  callback: ObserverCallback
  options: IntersectionObserverInit | undefined
  observed: Element[] = []
  disconnected = false

  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
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

function Probe() {
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  return (
    <div ref={ref} data-testid="probe">
      {inView ? 'visible' : 'hidden'}
    </div>
  )
}

describe('useInViewOnce', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('初始不可见；元素进入视口后置为可见且只触发一次（observer 断开）', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('hidden')

    const observer = MockIntersectionObserver.instances[0]
    expect(observer.observed).toHaveLength(1)
    expect(observer.disconnected).toBe(false)

    act(() => observer.trigger(true))
    expect(screen.getByTestId('probe').textContent).toBe('visible')
    expect(observer.disconnected).toBe(true)
  })

  it('未相交的回调不改变可见状态', () => {
    render(<Probe />)
    const observer = MockIntersectionObserver.instances[0]
    act(() => observer.trigger(false))
    expect(screen.getByTestId('probe').textContent).toBe('hidden')
    expect(observer.disconnected).toBe(false)
  })

  it('透传 rootMargin / threshold 选项', () => {
    function ProbeWithOptions() {
      const { ref } = useInViewOnce<HTMLDivElement>({ rootMargin: '480px', threshold: 0.5 })
      return <div ref={ref} />
    }
    render(<ProbeWithOptions />)
    const observer = MockIntersectionObserver.instances[0]
    expect(observer.options?.rootMargin).toBe('480px')
    expect(observer.options?.threshold).toBe(0.5)
  })

  it('无 IntersectionObserver 的环境降级为直接可见（不白屏）', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('visible')
  })
})
