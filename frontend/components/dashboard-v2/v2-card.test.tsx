import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { V2Card } from './v2-card'

describe('V2Card', () => {
  it('term 直角面板：零圆角 + term 边框 + term 面板背景 + 零阴影', () => {
    const { container } = render(<V2Card>content</V2Card>)
    const card = container.firstElementChild as HTMLElement
    expect(card).toBeTruthy()
    // BLF-979 Stage 2：从 surface 圆角卡改为 term 直角面板
    expect(card.className).toContain('rounded-none')
    expect(card.className).toContain('border-term-border')
    expect(card.className).toContain('bg-term-panel')
    expect(card.className).toContain('shadow-none')
    expect(card.className).not.toContain('rounded-lg')
    expect(card.className).not.toContain('bg-card')
  })

  it('保留自定义 className 追加能力', () => {
    const { container } = render(<V2Card className="md:col-span-2">content</V2Card>)
    expect(container.firstElementChild?.className).toContain('md:col-span-2')
    expect(container.firstElementChild?.className).toContain('rounded-none')
  })
})
