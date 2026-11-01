import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectRankTable } from './project-rank-table'

const rows = [
  {
    projectId: 1,
    projectName: '项目 A',
    totalSales: 1234.5,
    totalAdSpend: 56.78,
    change: 12.5,
  },
  {
    projectId: 2,
    projectName: '项目 B',
    totalSales: 800,
    totalAdSpend: 80,
    change: -2.25,
  },
]

describe('ProjectRankTable', () => {
  it('reports the controlled sort selection and calls back when the metric changes', () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <ProjectRankTable rows={rows} sortKey="sales" onSortChange={onSortChange} />
    )

    const sortGroup = screen.getByRole('group', { name: '项目排行排序' })
    expect(within(sortGroup).getByRole('button', { name: '销售额' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(sortGroup).getByRole('button', { name: '广告花费' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    fireEvent.click(within(sortGroup).getByRole('button', { name: '广告花费' }))
    expect(onSortChange).toHaveBeenCalledWith('ad_spend')

    rerender(<ProjectRankTable rows={rows} sortKey="ad_spend" onSortChange={onSortChange} />)
    expect(within(sortGroup).getByRole('button', { name: '广告花费' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('orders rows and scales bars using the active metric', () => {
    const { rerender } = render(
      <ProjectRankTable rows={rows} sortKey="sales" onSortChange={vi.fn()} />
    )

    const table = screen.getByRole('table', { name: '项目排行' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('项目 A')
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('项目 B')
    expect(within(table).getAllByTestId('project-rank-bar').map((bar) => bar.getAttribute('style')))
      .toEqual(['width: 100%;', 'width: 65%;'])

    rerender(<ProjectRankTable rows={rows} sortKey="ad_spend" onSortChange={vi.fn()} />)
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('项目 B')
    expect(within(table).getAllByTestId('project-rank-bar').map((bar) => bar.getAttribute('style')))
      .toEqual(['width: 100%;', 'width: 71%;'])
  })

  it('keeps a long project name readable without truncating its text', () => {
    const longName = '北美家居收纳与户外照明产品运营项目长期名称示例'
    render(
      <ProjectRankTable
        rows={[{ ...rows[0], projectName: longName }]}
        sortKey="sales"
        onSortChange={vi.fn()}
      />
    )

    expect(screen.getByText(longName)).toBeInTheDocument()
    expect(screen.getByText(longName).closest('td')?.className).not.toContain('truncate')
  })

  it('keeps rows passive unless an onClick callback is provided', () => {
    const { rerender } = render(
      <ProjectRankTable rows={rows} sortKey="sales" onSortChange={vi.fn()} />
    )
    const table = screen.getByRole('table', { name: '项目排行' })
    const passiveRow = within(table).getAllByRole('row')[1]
    expect(passiveRow).not.toHaveAttribute('tabindex')
    expect(passiveRow.className).not.toContain('hover:')

    const onClick = vi.fn()
    rerender(
      <ProjectRankTable rows={rows} sortKey="sales" onSortChange={vi.fn()} onClick={onClick} />
    )
    expect(within(table).getAllByRole('row')[1]).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开项目 项目 A' }))
    expect(onClick).toHaveBeenCalledWith(rows[0])
  })

  it('renders loading, empty, and error states', () => {
    const props = { rows: [], sortKey: 'sales' as const, onSortChange: vi.fn() }

    const { container, rerender } = render(<ProjectRankTable {...props} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载项目排行')
    expect(container.querySelector('table')).toHaveAttribute('aria-hidden', 'true')

    rerender(<ProjectRankTable {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent('暂无项目数据')

    rerender(<ProjectRankTable {...props} error="服务暂不可用" />)
    expect(screen.getByRole('alert')).toHaveTextContent('项目排行加载失败')
    expect(screen.getByRole('alert')).toHaveTextContent('服务暂不可用')
  })

  it('formats sales, spend, and change values for display', () => {
    render(<ProjectRankTable rows={rows.slice(0, 1)} sortKey="sales" onSortChange={vi.fn()} />)

    expect(screen.getByText('$1,234.50')).toBeInTheDocument()
    expect(screen.getByText('$56.78')).toBeInTheDocument()
    expect(screen.getByText(/12\.5%/)).toBeInTheDocument()
  })
})
