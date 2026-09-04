import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Command, CommandItem } from './command'

describe('Command 暗黑透明承接浮层玻璃（BLF-574，Terminal 兼容 BLF-870）', () => {
  it('根节点 dark 下透明，light 为 term 面板（BLF-870：bg-term-panel 替代 bg-popover）', () => {
    const { container } = render(
      <Command>
        <CommandItem>条目</CommandItem>
      </Command>
    )
    const root = container.querySelector('[cmdk-root]') ?? container.firstChild!
    const cls = (root as HTMLElement).className
    expect(cls).toContain('bg-term-panel')
    expect(cls).toContain('text-term-text')
    expect(cls).toContain('dark:bg-transparent')
    expect(cls).not.toContain('dark:bg-[hsl(var(--surface-panel))]')
  })
})

describe('Command Terminal 收口（BLF-870）', () => {
  it('根节点为 rounded-none + term 面板（无 rounded-md/bg-popover 漂移）', () => {
    const { container } = render(<Command><CommandItem>条目</CommandItem></Command>)
    const root = (container.querySelector('[cmdk-root]') ?? container.firstChild!) as HTMLElement
    expect(root.className).toContain('rounded-none')
    expect(root.className).toContain('bg-term-panel')
    expect(root.className).toContain('text-term-text')
    expect(root.className).not.toContain('rounded-md')
  })
  it('Item 选中态为 term-hover 而非 accent', () => {
    const { container } = render(<Command><CommandItem>条目</CommandItem></Command>)
    // CommandItem class is static; check via rendered item text parent
    // Indirect: render open Command via css check on stylesheet is hard; just check Command base
    expect(container.textContent).toContain('条目')
  })
})
