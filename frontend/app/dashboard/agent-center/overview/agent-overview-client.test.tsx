import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import AgentOverviewClient from './agent-overview-client'
import { AGENT_DOMAINS } from '@/lib/agent-domains'

describe('AgentOverviewClient 数据流总览（P2a）', () => {
  it('每个注册表域渲染一行(16 域 + 表头)', () => {
    render(<AgentOverviewClient />)
    expect(screen.getAllByRole('row')).toHaveLength(AGENT_DOMAINS.length + 1)
  })

  it('产出域置顶:客诉中心是第一行业务域', () => {
    render(<AgentOverviewClient />)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('客诉中心')
  })

  it('A 档产出域与 B 档工作台域都给出入口链接', () => {
    render(<AgentOverviewClient />)
    expect(
      screen.getByRole('link', { name: '打开客诉中心' }).getAttribute('href')
    ).toBe('/dashboard/operations/complaint-center')
    expect(screen.getByRole('link', { name: '打开库存台账' }).getAttribute('href')).toBe(
      '/dashboard/operations/inventory-ledger'
    )
  })

  it('规划中域(finance_profit)显示规划中且无入口链接', () => {
    render(<AgentOverviewClient />)
    expect(screen.getByText('规划中')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '打开财务利润' })).not.toBeInTheDocument()
  })

  it('已接入域的入口链接数 = 有 dashboardPath 的 live 域数', () => {
    render(<AgentOverviewClient />)
    const expected = AGENT_DOMAINS.filter((d) => d.status === 'live' && d.dashboardPath).length
    expect(screen.getAllByRole('link', { name: /^打开/ })).toHaveLength(expected)
  })
})
