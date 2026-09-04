import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu'

describe('DropdownMenu 暗黑浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>菜单</DropdownMenuTrigger>
        <DropdownMenuContent>条目</DropdownMenuContent>
      </DropdownMenu>
    )
    const content = document.body.querySelector('.u-floating-glass')!
    expect(content).toBeTruthy()
    expect(content.className).toContain('u-floating-glass')
    expect(content.getAttribute('role')).toBe('menu')
  })
})
