import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Command, CommandItem } from './command'

describe('Command 暗黑透明承接浮层玻璃（BLF-574）', () => {
  it('根节点 dark 下透明（让 Popover/Dialog 玻璃渐变透出），light 保持 bg-popover', () => {
    const { container } = render(
      <Command>
        <CommandItem>条目</CommandItem>
      </Command>
    )
    const root = container.querySelector('[cmdk-root]') ?? container.firstChild!
    const cls = (root as HTMLElement).className
    expect(cls).toContain('bg-popover')
    expect(cls).toContain('dark:bg-transparent')
    expect(cls).not.toContain('dark:bg-[hsl(var(--surface-panel))]')
  })
})
