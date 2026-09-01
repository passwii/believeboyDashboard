import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { V2Card } from './v2-card'

describe('V2Card', () => {
  it('surface 面板风：圆角 + 边框 + 卡片背景 + 阴影令牌', () => {
    const { container } = render(<V2Card>content</V2Card>)
    const card = container.firstElementChild as HTMLElement
    expect(card).toBeTruthy()
    // 从 terminal 直角（rounded-none border-0）改为 surface 圆角卡（BLF-911 收口）
    expect(card.className).toContain('rounded-lg')
    expect(card.className).toContain('bg-card')
    expect(card.className).toContain('shadow-soft')
    expect(card.className).not.toContain('rounded-none')
    expect(card.className).not.toContain('border-0')
  })

  it('保留自定义 className 追加能力', () => {
    const { container } = render(<V2Card className="md:col-span-2">content</V2Card>)
    expect(container.firstElementChild?.className).toContain('md:col-span-2')
    expect(container.firstElementChild?.className).toContain('rounded-lg')
  })
})
