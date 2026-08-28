import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  DENSE_CELL,
  DENSE_HEAD,
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DataTableCardStatBar,
} from './data-card'
import { densityCell, densityHead } from './table-presets'

describe('data-card · 表格卡片外壳', () => {
  it('DataTableCard 渲染 children 并带 term 平板基座（BLF-872：零圆角/零阴影）', () => {
    const { container } = render(
      <DataTableCard>
        <span>content</span>
      </DataTableCard>
    )
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(container.firstChild).toHaveClass('rounded-none')
    expect(container.firstChild).toHaveClass('border-term-border')
    expect(container.firstChild).toHaveClass('bg-term-panel')
    expect(container.firstChild).toHaveClass('shadow-none')
    expect(container.firstChild).not.toHaveClass('dashboard-surface')
  })

  it('DataTableCardHeader 渲染 title / description / action', () => {
    render(
      <DataTableCardHeader title="批次列表" description="明细" action={<button>导出</button>} />
    )
    expect(screen.getByText('批次列表')).toBeInTheDocument()
    expect(screen.getByText('明细')).toBeInTheDocument()
    expect(screen.getByText('导出')).toBeInTheDocument()
  })

  it('DataTableCardHeader 支持任意子元素（children 优先）', () => {
    render(<DataTableCardHeader><div>custom header</div></DataTableCardHeader>)
    expect(screen.getByText('custom header')).toBeInTheDocument()
  })

  it('DataTableCardBody 透传 className', () => {
    const { container } = render(<DataTableCardBody className="min-w-0">x</DataTableCardBody>)
    expect(container.firstChild).toHaveClass('min-w-0')
  })
})

describe('data-card · DENSE_* 兼容别名（唯一配方收敛）', () => {
  it('DENSE_HEAD / DENSE_CELL 与 table-presets compact 档位一致', () => {
    expect(DENSE_HEAD).toBe(densityHead.compact)
    expect(DENSE_CELL).toBe(densityCell.compact)
  })
})

describe('data-card · DataTableCardStatBar', () => {
  it('渲染 label / value / highlight', () => {
    render(
      <DataTableCardStatBar
        items={[
          { label: '回款', value: '1,000', highlight: true },
          { label: '在途', value: '200' },
        ]}
      />
    )
    expect(screen.getByText('回款')).toBeInTheDocument()
    expect(screen.getByText('1,000')).toBeInTheDocument()
    expect(screen.getByText('在途')).toBeInTheDocument()
    expect(screen.getByText('200')).toBeInTheDocument()
  })

  it('items 为空时不渲染', () => {
    const { container } = render(<DataTableCardStatBar items={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
