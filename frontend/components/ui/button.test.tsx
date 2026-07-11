import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from './button'

describe('Button motion classes', () => {
  it('includes motion utility classes (u-press / u-focus / u-interactive)', () => {
    const { container } = render(<Button>x</Button>)
    const btn = container.querySelector('button')!
    const cls = btn.className
    expect(cls).toMatch(/\bu-press\b/)
    expect(cls).toMatch(/\bu-focus\b/)
    expect(cls).toMatch(/\bu-interactive\b/)
    expect(cls).toMatch(/focus-visible:outline/)
  })

  it('honours disabled (no transform target)', () => {
    const { container } = render(<Button disabled>x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})
