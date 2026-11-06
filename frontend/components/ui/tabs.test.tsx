import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import { SlidingTabsTrigger } from './tab-motion'

function renderTermTabs() {
  return render(
    <Tabs defaultValue="a">
      <TabsList variant="term">
        <TabsTrigger variant="term" value="a">
          a
        </TabsTrigger>
        <TabsTrigger variant="term" value="b">
          b
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

describe('Tabs Terminal 收口（BLF-867）', () => {
  it('term 档为 h-10 零圆角 mono 小字（BLF-887 上档页头级导航档），且无 translate 溢出源', () => {
    const { container } = renderTermTabs()
    const list = container.querySelector('[role="tablist"]')!
    expect(list.className).toContain('h-10')
    expect(list.className).toContain('rounded-none')
    const trigger = container.querySelector('[role="tab"]')!
    expect(trigger.className).toContain('h-10')
    expect(trigger.className).toContain('rounded-none')
    expect(trigger.className).toContain('font-mono')
    expect(trigger.className).not.toContain('-translate-y-px')
  })

  it('term 选中态：抬升底 + 内嵌 accent 发光指示条（不溢出容器）', () => {
    const { container } = renderTermTabs()
    const trigger = container.querySelector('[role="tab"]')!
    const cls = trigger.className
    expect(cls).toContain('data-[state=active]:bg-term-raised')
    expect(cls).toContain('data-[state=active]:text-term-text')
    expect(cls).toContain('data-[state=active]:after:absolute')
    expect(cls).toContain('data-[state=active]:after:inset-x-0')
    expect(cls).toContain('data-[state=active]:after:bottom-0')
    expect(cls).toContain('data-[state=active]:after:h-[2px]')
    expect(cls).toContain('data-[state=active]:after:bg-term-accent')
    expect(cls).not.toContain('data-[state=active]:border-term-border-strong')
  })

  it('default 档保持原 min-h-11 圆角渐变基座（回归页不受影响）', () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">a</TabsTrigger>
        </TabsList>
      </Tabs>
    )
    const list = container.querySelector('[role="tablist"]')!
    expect(list.className).toContain('min-h-11')
    expect(list.className).toContain('rounded-2xl')
    const trigger = container.querySelector('[role="tab"]')!
    expect(trigger.className).toContain('min-h-[2.85rem]')
  })
})

describe('Tabs Warm Ledger variant', () => {
  it('uses the warm neutral list surface and keeps trigger text in the V4 palette', () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList variant="warm">
          <TabsTrigger variant="warm" value="a">
            a
          </TabsTrigger>
          <TabsTrigger variant="warm" value="b">
            b
          </TabsTrigger>
        </TabsList>
      </Tabs>
    )
    const list = container.querySelector('[role="tablist"]')!
    const trigger = container.querySelector('[role="tab"]')!

    expect(list.className).toContain('rounded-[var(--warm-ledger-radius-control)]')
    expect(list.className).toContain('border-[var(--warm-ledger-color-hairline)]')
    expect(list.className).not.toContain('border-term-border')
    expect(trigger.className).toContain('text-[var(--warm-ledger-color-text-muted)]')
    expect(trigger.className).toContain('data-[state=active]:bg-[var(--warm-ledger-color-raised)]')
    expect(trigger.className).not.toContain('data-[state=active]:bg-term-raised')
    expect(trigger.className).not.toMatch(/0_0_(8|10|16)px/)
  })

  it('gives the sliding warm indicator a neutral raised fill and a 2px amber marker only', () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList variant="warm">
          <SlidingTabsTrigger
            value="a"
            activeValue="a"
            layoutId="warm-tab"
            variant="warm"
          >
            a
          </SlidingTabsTrigger>
          <SlidingTabsTrigger
            value="b"
            activeValue="a"
            layoutId="warm-tab"
            variant="warm"
          >
            b
          </SlidingTabsTrigger>
        </TabsList>
      </Tabs>
    )
    const activeTrigger = container.querySelector('[role="tab"][data-state="active"]')!
    const indicator = activeTrigger.querySelector('span.absolute')!

    expect(indicator.className).toContain('bg-[var(--warm-ledger-color-raised)]')
    expect(indicator.className).toContain('border-[var(--warm-ledger-color-hairline-strong)]')
    expect(indicator.className).not.toContain('after:')
    expect(activeTrigger.className).toContain(
      'data-[state=active]:after:bg-[var(--warm-ledger-color-accent)]'
    )
    expect(indicator.className).not.toContain('bg-term-accent')
    expect(indicator.className).not.toContain('shadow-[0_0_')
  })
})
