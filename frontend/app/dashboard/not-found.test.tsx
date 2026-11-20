import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import DashboardNotFoundPage from './not-found'

describe('dashboard not-found page', () => {
  it('offers dashboard home and back navigation without a retry action', () => {
    const { container } = render(<DashboardNotFoundPage />)

    expect(screen.getByRole('heading', { name: '当前功能页无法访问' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新加载|重试/ })).not.toBeInTheDocument()
    expect(container.querySelector('.warm-ledger')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('当前功能页无法访问')
  })
})
