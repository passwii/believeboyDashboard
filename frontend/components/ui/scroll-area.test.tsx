import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { act, render, waitFor } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { ScrollArea, ScrollBar } from './scroll-area'

/**
 * Radix Scrollbar 需要 ScrollArea context，且滑块仅在「有溢出」时挂载。
 * jsdom 无真实布局，这里用手动 ResizeObserver 桩接管尺寸回调，
 * 伪造 viewport 溢出后触发 Radix 的 size 测量，令滑块进入 DOM。
 */
type ROCallback = (entries: unknown[], observer: unknown) => void
const roCallbacks = new Set<ROCallback>()

class ManualResizeObserver {
  private readonly cb: ROCallback

  constructor(cb: ROCallback) {
    this.cb = cb
    roCallbacks.add(cb)
  }

  observe() {}
  unobserve() {}
  disconnect() {
    roCallbacks.delete(this.cb)
  }
}

vi.stubGlobal('ResizeObserver', ManualResizeObserver)

afterAll(() => {
  vi.unstubAllGlobals()
})

function fireResize() {
  act(() => {
    for (const cb of [...roCallbacks]) cb([], {})
  })
}

/**
 * 用 `type="always"` 的原始 Root 承载本仓库 ScrollBar 原语，
 * 伪造 vertical/horizontal 溢出后等待 Radix 10ms 防抖尺寸测量。
 */
async function renderBarWithOverflow(orientation: 'vertical' | 'horizontal') {
  const utils = render(
    <ScrollAreaPrimitive.Root type="always">
      <ScrollAreaPrimitive.Viewport>
        <div>内容</div>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation={orientation} />
    </ScrollAreaPrimitive.Root>
  )
  const viewport = utils.container.querySelector('[data-radix-scroll-area-viewport]')!
  if (orientation === 'vertical') {
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 500 })
    Object.defineProperty(viewport, 'offsetHeight', { configurable: true, value: 100 })
  } else {
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 500 })
    Object.defineProperty(viewport, 'offsetWidth', { configurable: true, value: 100 })
  }
  fireResize()
  await waitFor(() => {
    expect(utils.container.querySelector('[data-orientation] [data-state]')).toBeTruthy()
  })
  return utils
}

describe('ScrollArea Terminal 收口（BLF-873）', () => {
  it('滚动条滑块：零圆角 + term-border-strong（对齐 .term-scroll 细条风格）', async () => {
    const { container } = await renderBarWithOverflow('vertical')
    const thumb = container.querySelector('[data-orientation] [data-state]')
    expect(thumb).toBeTruthy()
    expect(thumb?.className).toContain('rounded-none')
    expect(thumb?.className).toContain('bg-term-border-strong')
    expect(thumb?.className).not.toContain('rounded-full')
  })

  it('竖向滚动条宽度收敛为 8px（w-2，与 term-scroll 一致）', async () => {
    const { container } = await renderBarWithOverflow('vertical')
    const scrollbar = container.querySelector('[data-orientation="vertical"]')
    expect(scrollbar?.className).toContain('w-2')
    expect(scrollbar?.className).not.toContain('w-2.5')
  })

  it('横向滚动条高度收敛为 8px（h-2）', async () => {
    const { container } = await renderBarWithOverflow('horizontal')
    const scrollbar = container.querySelector('[data-orientation="horizontal"]')
    expect(scrollbar?.className).toContain('h-2')
    expect(scrollbar?.className).not.toContain('h-2.5')
  })

  it('ScrollArea 视口保持满尺寸裁剪', () => {
    const { container } = render(
      <ScrollArea>
        <div>内容</div>
      </ScrollArea>
    )
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')
    expect(viewport?.className).toContain('h-full')
    expect(viewport?.className).toContain('w-full')
  })
})
