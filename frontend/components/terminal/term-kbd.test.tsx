import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TermKbd } from './term-kbd'

describe('TermKbd', () => {
  it('BLF-832 A6：统一 kbd 实现（border/px-1/font-mono/text-xs/leading-4/text-term-faint）', () => {
    render(<TermKbd>⌘K</TermKbd>)
    const el = screen.getByText('⌘K')
    for (const cls of ['border-term-border', 'px-1', 'font-mono', 'text-xs', 'leading-4', 'text-term-faint']) {
      expect(el.className).toContain(cls)
    }
  })

  it('支持透传 className 与原生属性', () => {
    render(
      <TermKbd className="ml-auto" data-testid="kbd-x">
        ⌘B
      </TermKbd>
    )
    const el = screen.getByTestId('kbd-x')
    expect(el.className).toContain('ml-auto')
    expect(el.tagName).toBe('KBD')
  })
})
