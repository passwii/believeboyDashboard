import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LoginBrandPanel } from './login-brand-panel'

describe('LoginBrandPanel', () => {
  it('presents the brand and factual workspace description', () => {
    render(<LoginBrandPanel />)

    expect(screen.getByRole('heading', { level: 1, name: '彼励扶跨境' })).toBeVisible()
    expect(screen.getByText('BelieveBoy', { exact: true })).toBeVisible()
    expect(screen.getByText('跨境电商运营工作区')).toBeVisible()
  })

  it('does not claim live session, auth health, or latency', () => {
    render(<LoginBrandPanel />)

    expect(screen.queryByText(/会话已建立|认证服务可达|延迟\s*\d+ms/)).not.toBeInTheDocument()
  })
})
