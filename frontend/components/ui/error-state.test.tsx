import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ErrorState } from './error-state'

describe('ErrorState', () => {
  it('渲染默认标题与错误详情', () => {
    render(<ErrorState message="接口超时" />)
    expect(screen.getByText('加载失败')).toBeInTheDocument()
    expect(screen.getByText('接口超时')).toBeInTheDocument()
  })

  it('可传自定义标题与重试按钮', () => {
    const onRetry = vi.fn()
    render(<ErrorState title="数据加载失败" onRetry={onRetry} />)
    const button = screen.getByRole('button', { name: '重试' })
    button.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('不传 onRetry 时不渲染按钮', () => {
    render(<ErrorState title="失败" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('colSpan 用法渲染表格错误行（td colSpan）', () => {
    const { container } = render(<ErrorState title="加载失败" colSpan={6} />)
    const td = container.querySelector('td')
    expect(td).toBeTruthy()
    expect(td?.getAttribute('colspan')).toBe('6')
  })
})
