import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CrmLoading from './loading'

describe('CrmLoading', () => {
  it('uses the Warm CRM loading surface instead of the Terminal table skeleton', () => {
    const { container } = render(<CrmLoading />)

    expect(screen.getByRole('status')).toHaveTextContent('客户关系加载中')
    expect(container.querySelector('[data-warm-crm-loading="true"]')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
    expect(container.querySelector('.rounded-none')).not.toBeInTheDocument()
  })
})
