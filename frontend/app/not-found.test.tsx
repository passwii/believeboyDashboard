import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import NotFoundPage from './not-found'

describe('root not-found page', () => {
  it('offers home and back navigation without a retry action', () => {
    const { container } = render(<NotFoundPage />)

    expect(screen.getByRole('heading', { name: '你访问的页面不存在' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新加载|重试/ })).not.toBeInTheDocument()
    expect(container.querySelector('.warm-ledger')).toBeInTheDocument()
  })
})
