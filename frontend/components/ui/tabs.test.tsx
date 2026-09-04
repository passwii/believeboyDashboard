import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tabs, TabsList, TabsTrigger } from './tabs'

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
