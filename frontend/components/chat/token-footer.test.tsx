import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TokenFooter } from './token-footer'

describe('TokenFooter', () => {
  it('tokenUsage 和 durationMs 都缺时返回 null', () => {
    const { container } = render(<TokenFooter />)
    expect(container.firstChild).toBeNull()
  })

  it('tokenUsage 全 0 时不渲染 token chip', () => {
    const { container } = render(<TokenFooter tokenUsage={{ prompt: 0, completion: 0, total: 0 }} />)
    expect(container.firstChild).toBeNull()
  })

  it('durationMs 为 null/0/undefined 时不渲染 duration chip', () => {
    const { rerender, container } = render(
      <TokenFooter tokenUsage={{ prompt: 100, completion: 50, total: 150 }} durationMs={null} />
    )
    expect(container.querySelector('[aria-label*="耗时"]')).toBeNull()

    rerender(<TokenFooter tokenUsage={{ prompt: 100, completion: 50, total: 150 }} durationMs={0} />)
    expect(container.querySelector('[aria-label*="耗时"]')).toBeNull()

    rerender(<TokenFooter tokenUsage={{ prompt: 100, completion: 50, total: 150 }} />)
    expect(container.querySelector('[aria-label*="耗时"]')).toBeNull()
  })

  it('渲染 token 总数 + in/out 分解', () => {
    render(<TokenFooter tokenUsage={{ prompt: 820, completion: 412, total: 1232 }} />)
    // total 用紧凑格式 1.2k
    expect(screen.getByText('1.2k')).toBeTruthy()
    // prompt/completion 各自紧凑
    expect(screen.getByText('820')).toBeTruthy()
    expect(screen.getByText('412')).toBeTruthy()
    // aria-label 汇总
    expect(screen.getByLabelText(/消耗 1\.2k tokens/)).toBeTruthy()
  })

  it('durationMs 渲染 Timer chip 并正确格式化', () => {
    const { rerender } = render(<TokenFooter durationMs={850} />)
    expect(screen.getByText('850ms')).toBeTruthy()

    rerender(<TokenFooter durationMs={1820} />)
    expect(screen.getByText('1.8s')).toBeTruthy()
  })

  it('token + duration 同时存在时两个 chip 都渲染', () => {
    render(<TokenFooter tokenUsage={{ prompt: 10, completion: 5, total: 15 }} durationMs={320} />)
    expect(screen.getByLabelText(/消耗/)).toBeTruthy()
    expect(screen.getByLabelText(/耗时/)).toBeTruthy()
  })
})