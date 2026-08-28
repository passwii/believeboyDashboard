import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Label } from './label'

describe('Label Terminal 收口（BLF-869）', () => {
  it('基类为 mono 小字 + 大写字距 + term-muted（与 form 密度一致）', () => {
    const { container } = render(<Label>名称</Label>)
    const el = container.querySelector('label')!
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-xs')
    expect(el.className).toContain('uppercase')
    expect(el.className).toContain('tracking-wider')
    expect(el.className).toContain('text-term-muted')
  })

  it('禁用态保留 peer-disabled 令牌', () => {
    const { container } = render(<Label>名称</Label>)
    const cls = container.querySelector('label')!.className
    expect(cls).toContain('peer-disabled:cursor-not-allowed')
    expect(cls).toContain('peer-disabled:opacity-70')
  })
})
