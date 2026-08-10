import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

describe('Tooltip 暗黑小号浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
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
    expect(content.className).toContain('bg-popover')
  })
})
