import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Switch } from './switch'

describe('Switch 暗黑玻璃边高光（BLF-574）', () => {
  it('轨道带暗黑顶部内高光（与卡片同一语言）', () => {
    const { container } = render(<Switch />)
    const track = container.querySelector('[role="switch"]')!
    expect(track.className).toContain('dark:shadow-[inset_0_1px_0_hsl')
  })

  it('light 模式保留原 shadow-sm', () => {
    const { container } = render(<Switch />)
    const track = container.querySelector('[role="switch"]')!
    expect(track.className).toContain('shadow-sm')
  })
})
