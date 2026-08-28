import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

describe('Tooltip 暗黑小号浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass 且 Terminal 令牌（border-term-border / bg-term-panel / rounded-none / shadow-none）', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>悬停</TooltipTrigger>
          <TooltipContent forceMount>提示</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    const content = document.body.querySelector('.u-floating-glass')!
    expect(content).toBeTruthy()
    expect(content.className).toContain('u-floating-glass')
    expect(content.className).toContain('border-term-border')
    expect(content.className).toContain('bg-term-panel')
    expect(content.className).toContain('rounded-none')
    expect(content.className).toContain('shadow-none')
    expect(content.className).not.toContain('bg-popover')
    expect(content.className).not.toContain('shadow-md')
  })
})
