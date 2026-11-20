import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CrmNotFound from './not-found'

describe('CRM not-found page', () => {
  it('keeps CRM copy and customer-list navigation without a retry action', () => {
    const { container } = render(<CrmNotFound />)

    expect(screen.getByRole('heading', { name: 'CRM 页面不存在' })).toBeInTheDocument()
    expect(screen.getByText('你访问的 CRM 路径未定义。回到客户列表继续操作。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回客户列表' })).toHaveAttribute(
      'href',
      '/dashboard/crm/customers'
    )
    expect(screen.queryByRole('button', { name: /重新加载|重试/ })).not.toBeInTheDocument()
    expect(container.querySelector('.warm-ledger')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('CRM 页面不存在')
  })
})
