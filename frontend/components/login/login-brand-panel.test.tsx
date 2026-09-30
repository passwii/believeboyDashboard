import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LoginBrandPanel } from './login-brand-panel'
import { LOGIN_WORKSPACE_DOMAINS } from './login-workspace-domains'

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

  it('预览登录后可进入的 8 个业务域（登录前不渲染为可点击入口）', () => {
    render(<LoginBrandPanel />)

    const map = screen.getByRole('list')
    const rows = within(map).getAllByRole('listitem')
    expect(rows).toHaveLength(LOGIN_WORKSPACE_DOMAINS.length)
    for (const [index, domain] of LOGIN_WORKSPACE_DOMAINS.entries()) {
      expect(within(rows[index]).getByText(domain.label)).toBeVisible()
    }
    // 行内没有任何可交互控件：未登录点击业务域只会被中间件弹回登录页
    expect(within(map).queryAllByRole('link')).toHaveLength(0)
    expect(within(map).queryAllByRole('button')).toHaveLength(0)
  })
})
