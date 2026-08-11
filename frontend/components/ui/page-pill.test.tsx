import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Boxes } from 'lucide-react'

import { PagePill } from './page-pill'

describe('PagePill（BLF-634 统一定制）', () => {
  it('渲染统一配方：h-9 等高 + icon h-4 w-4 强制 + 胶囊视觉', () => {
    const { container } = render(<PagePill icon={<Boxes />}>运营 · 补货分析</PagePill>)
    expect(screen.getByText('运营 · 补货分析')).toBeInTheDocument()

    const pill = container.querySelector('span')
    // 高度定死 h-9（与右侧操作按钮等高，BLF-605 跟进）
    expect(pill?.className).toContain('h-9')
    expect(pill?.className).toContain('rounded-full')
    expect(pill?.className).toContain('border-primary/25')
    expect(pill?.className).toContain('bg-primary/10')
    expect(pill?.className).toContain('text-primary/90')
    // 配方文字样式
    expect(pill?.className).toContain('text-xs')
    expect(pill?.className).toContain('tracking-[0.14em]')
  })

  it('icon 由组件统一为 h-4 w-4（调用方无需传尺寸类）', () => {
    const { container } = render(<PagePill icon={<Boxes />}>运营 · 补货分析</PagePill>)
    // 组件内部包一层 span 强制 svg 尺寸 h-4 w-4
    const iconWrapper = container.querySelector('span > span')
    expect(iconWrapper?.className).toContain('[&>svg]:h-4')
    expect(iconWrapper?.className).toContain('[&>svg]:w-4')
  })

  it('无 icon 时仅渲染文字，不产生空节点', () => {
    const { container } = render(<PagePill>运营 · 补货分析</PagePill>)
    expect(screen.getByText('运营 · 补货分析')).toBeInTheDocument()
    expect(container.querySelectorAll('span > span').length).toBe(0)
  })

  it('支持透传 className 追加', () => {
    const { container } = render(<PagePill className="md:px-5">运营 · 补货分析</PagePill>)
    expect(container.querySelector('span')?.className).toContain('md:px-5')
  })
})
