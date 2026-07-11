import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MotionStagger, MotionStaggerItem } from './MotionStagger'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('MotionStagger', () => {
  it('renders container + children wrapped as stagger items', () => {
    const { container } = render(
      <MotionStagger>
        <MotionStaggerItem><div data-testid="a">a</div></MotionStaggerItem>
        <MotionStaggerItem><div data-testid="b">b</div></MotionStaggerItem>
      </MotionStagger>,
    )
    expect(container.querySelectorAll('[data-testid="a"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="b"]')).toHaveLength(1)
  })

  it('items start with opacity 0 (initial)', () => {
    const { container } = render(
      <MotionStagger>
        <MotionStaggerItem>x</MotionStaggerItem>
      </MotionStagger>,
    )
    // MotionStaggerItem 渲染一个 motion.div，初始 inline style 含 opacity:0
    const itemDiv = container.querySelector(
      'div[style*="opacity"]',
    ) as HTMLElement | null
    expect(itemDiv).toBeTruthy()
    expect(itemDiv?.style.opacity).toBe('0')
  })
})