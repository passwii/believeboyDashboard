import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MotionFade } from './MotionFade'

// 让 framer-motion 的 useReducedMotion 在测试中可控
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => false }
})

describe('MotionFade', () => {
  it('renders children inside a motion.div', () => {
    const { getByTestId, container } = render(
      <MotionFade><div data-testid="kid">x</div></MotionFade>,
    )
    expect(getByTestId('kid')).toBeInTheDocument()
    expect(container.querySelector('[style*="opacity"]')).toBeTruthy()
  })

  it('applies initial opacity 0', () => {
    const { container } = render(<MotionFade>x</MotionFade>)
    const motionDiv = container.firstChild as HTMLElement
    expect(motionDiv.style.opacity).toBe('0')
  })
})