import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Separator } from './separator'

describe('Separator Terminal 收口（BLF-873）', () => {
  it('水平分割线走 term 边框令牌（深浅主题自动翻转）', () => {
    const { container } = render(<Separator />)
    const separator = container.firstElementChild
    expect(separator?.className).toContain('bg-term-border')
    expect(separator?.className).toContain('h-[1px]')
    expect(separator?.className).toContain('w-full')
  })

  it('垂直分割线同走 term 边框令牌', () => {
    const { container } = render(<Separator orientation="vertical" />)
    const separator = container.firstElementChild
    expect(separator?.className).toContain('bg-term-border')
    expect(separator?.className).toContain('w-[1px]')
    expect(separator?.className).toContain('h-full')
  })
})
