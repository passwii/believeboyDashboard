import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  DataTableFrame,
  StatusPill,
  densityCell,
  densityHead,
  numericCell,
  numericHead,
  statusPillClass,
} from './table-presets'
import { DENSE_CELL, DENSE_HEAD } from './data-card'

describe('table-presets · density', () => {
  it('compact 档位与历史 DENSE_* 别名同源（唯一配方）', () => {
    expect(densityHead.compact).toBe(DENSE_HEAD)
    expect(densityCell.compact).toBe(DENSE_CELL)
  })

  it('compact / cozy 档位均覆写默认 padding/字号', () => {
    expect(densityHead.compact).toContain('!h-9')
    expect(densityHead.cozy).toContain('!h-11')
    expect(densityCell.compact).toContain('!py-2')
    expect(densityCell.cozy).toContain('!py-3')
  })
})

describe('table-presets · numeric', () => {
  it('数字格右对齐 + 等宽数字', () => {
    expect(numericCell).toContain('text-right')
    expect(numericCell).toContain('tabular-nums')
  })

  it('数字表头用 !text-right 显式覆写表头默认 text-left', () => {
    expect(numericHead).toContain('!text-right')
    expect(numericHead).toContain('tabular-nums')
  })
})

describe('table-presets · StatusPill', () => {
  it('渲染 label 与状态点（BLF-872：pill 零圆角 + mono，状态点保留圆形）', () => {
    const { container } = render(<StatusPill status="success" label="已回款" />)
    expect(screen.getByText('已回款')).toBeInTheDocument()
    const pill = container.querySelector('[data-slot="status-pill"]')
    expect(pill).toBeTruthy()
    expect(pill?.className).toContain('rounded-none')
    expect(pill?.className).toContain('font-mono')
    expect(container.querySelector('[data-slot="status-pill"] [data-slot="status-dot"]')).toBeTruthy()
  })

  it('dot=false 时不渲染状态点', () => {
    const { container } = render(<StatusPill status="warning" label="待对账" dot={false} />)
    expect(screen.getByText('待对账')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('五种状态都有对应 pill 类（映射 --data-* token）', () => {
    for (const status of ['success', 'warning', 'negative', 'neutral', 'info'] as const) {
      expect(statusPillClass[status]).toMatch(/bg-\[hsl\(var\(--/)
    }
  })
})

describe('table-presets · DataTableFrame', () => {
  it('渲染标题 / 描述 / action / children', () => {
    render(
      <DataTableFrame
        title="发票列表"
        description="基线"
        action={<button>导出</button>}
      >
        <table>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
      </DataTableFrame>
    )
    expect(screen.getByText('发票列表')).toBeInTheDocument()
    expect(screen.getByText('基线')).toBeInTheDocument()
    expect(screen.getByText('导出')).toBeInTheDocument()
    expect(screen.getByText('cell')).toBeInTheDocument()
  })

  it('toolbar / footer 槽位渲染', () => {
    render(
      <DataTableFrame toolbar={<input placeholder="筛选" />} footer={<span>第 1/1 页</span>}>
        <table />
      </DataTableFrame>
    )
    expect(screen.getByPlaceholderText('筛选')).toBeInTheDocument()
    expect(screen.getByText('第 1/1 页')).toBeInTheDocument()
  })

  it('maxHeight 时滚动体启用纵向滚动（sticky 表头前提）', () => {
    const { container } = render(<DataTableFrame maxHeight={320}><table /></DataTableFrame>)
    const scrollable = container.querySelector('.overflow-y-auto')
    expect(scrollable).toBeTruthy()
    expect((scrollable as HTMLElement).style.maxHeight).toBe('320px')
  })
})
