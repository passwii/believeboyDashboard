import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { V2Card } from './v2-card'

describe('V2Card', () => {
  it('卡片无边框（border-0）——分隔线由 V2Grid 的 gap-px + bg 发丝线承担（BLF-624）', () => {
    const { container } = render(<V2Card>content</V2Card>)
    const card = container.firstElementChild as HTMLElement
    expect(card).toBeTruthy()
    // 基础 Card/dashboard-surface 自带 border，V2Card 必须显式覆盖为 border-0，
    // 否则每张卡 1px border + 网格 1px gap 叠加成双层边框
    expect(card.className).toContain('border-0')
    expect(card.className).toContain('rounded-none')
  })

  it('保留自定义 className 追加能力', () => {
    const { container } = render(<V2Card className="md:col-span-2">content</V2Card>)
    expect(container.firstElementChild?.className).toContain('md:col-span-2')
    expect(container.firstElementChild?.className).toContain('border-0')
  })
})
