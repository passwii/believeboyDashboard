import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock useLiveStream — 默认返回空数组（无今日出单事件）
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'

const mockUseLiveStream = vi.fn<(enabled: boolean) => LiveStreamItem[]>(() => [])

vi.mock('@/components/terminal/use-live-stream', () => ({
  useLiveStream: (...args: Parameters<typeof mockUseLiveStream>) => mockUseLiveStream(...args),
}))

// mock next/link（简化：渲染为 <a>）
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
    ...props
  }: {
    children: React.ReactNode
    href: string
    className?: string
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}))

import { V2OrderFlowPanel, type V2OrderFlowRow, type V2ProjectEntry } from './v2-order-flow-panel'

const mockRows: V2OrderFlowRow[] = [
  { date: '2026-08-25', pending_order_qty: 0, order_qty: 10, sales_amount: 1000 },
  { date: '2026-08-26', pending_order_qty: 0, order_qty: 15, sales_amount: 1500 },
  { date: '2026-08-27', pending_order_qty: 0, order_qty: 12, sales_amount: 1200 },
  { date: '2026-08-28', pending_order_qty: 0, order_qty: 8, sales_amount: 800 },
  { date: '2026-08-29', pending_order_qty: 3, order_qty: 20, sales_amount: 2000 },
  { date: '2026-08-30', pending_order_qty: 5, order_qty: 18, sales_amount: 1800 },
  { date: '2026-08-31', pending_order_qty: 7, order_qty: 22, sales_amount: 2200 },
]

const projectBreakdown: Record<number, V2ProjectEntry> = {
  1: { project_name: '项目A', summary_rows: mockRows },
  2: { project_name: '项目B', summary_rows: mockRows.slice(0, 3) },
  3: { project_name: '项目C', summary_rows: [
    { date: '2026-08-31', pending_order_qty: 2, order_qty: 5, sales_amount: 500 },
  ]},
}

const projects = [
  { id: 1, name: '项目A' },
  { id: 2, name: '项目B' },
  { id: 3, name: '项目C' },
  { id: 4, name: '项目D' },
]

describe('V2OrderFlowPanel', () => {
  beforeEach(() => {
    mockUseLiveStream.mockReturnValue([])
    // 默认 localStorage 无值 → 折叠态
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    })
  })

  describe('折叠态（默认）', () => {
    it('渲染折叠窄条', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      expect(screen.getByText('订单流')).toBeInTheDocument()
      expect(screen.getByLabelText('展开订单流面板')).toBeInTheDocument()
    })

    it('显示待处理计数徽标（最后一行 pending_order_qty = 7）', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      expect(screen.getByText('7')).toBeInTheDocument()
    })

    it('pending 为 0 时不显示徽标', () => {
      render(
        <V2OrderFlowPanel
          currentRows={[{ date: '2026-08-31', pending_order_qty: 0, order_qty: 0, sales_amount: 0 }]}
          projectBreakdown={{}}
          projects={[]}
        />
      )
      expect(screen.queryByText('0')).not.toBeInTheDocument()
    })

    it('pending > 99 显示 99+', () => {
      render(
        <V2OrderFlowPanel
          currentRows={[{ date: '2026-08-31', pending_order_qty: 150, order_qty: 0, sales_amount: 0 }]}
          projectBreakdown={{}}
          projects={[]}
        />
      )
      expect(screen.getByText('99+')).toBeInTheDocument()
    })
  })

  describe('展开态', () => {
    it('点击折叠窄条展开面板', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('订单流 · 待处理')).toBeInTheDocument()
      expect(screen.getByText('件待处理')).toBeInTheDocument()
      // 折叠窄条消失
      expect(screen.queryByLabelText('展开订单流面板')).not.toBeInTheDocument()
      // 收起按钮出现
      expect(screen.getByLabelText('收起订单流面板')).toBeInTheDocument()
    })

    it('收起按钮回到折叠态', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      fireEvent.click(screen.getByLabelText('收起订单流面板'))
      expect(screen.getByLabelText('展开订单流面板')).toBeInTheDocument()
      expect(screen.queryByLabelText('收起订单流面板')).not.toBeInTheDocument()
    })

    it('展开时显示待处理件数 = 最新 pending_order_qty', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 最后一行 pending_order_qty = 7（头部徽标 + 摘要 + 项目分解出现多次，取摘要区的第一个）
      expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('件待处理')).toBeInTheDocument()
    })

    it('项目分解按 pending 排序取 Top 5', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 待处理项目标题
      expect(screen.getByText('待处理项目')).toBeInTheDocument()
      // 项目A(7) > 项目C(2) > 项目B(0排除)
      expect(screen.getByText('项目A')).toBeInTheDocument()
      expect(screen.getByText('项目C')).toBeInTheDocument()
      // 项目B pending=0 不应出现
      expect(screen.queryByText('项目B')).not.toBeInTheDocument()
      // 项目D 无 projectBreakdown 不应出现
      expect(screen.queryByText('项目D')).not.toBeInTheDocument()
    })

    it('展开时显示今日出单区块', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('今日出单')).toBeInTheDocument()
      // 空态：无 live-stream 数据
      expect(screen.getByTestId('order-stream-empty')).toBeInTheDocument()
    })

    it('底部链接指向订单信息页', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('查看完整订单信息')).toBeInTheDocument()
      const link = screen.getByText('查看完整订单信息').closest('a')
      expect(link).toHaveAttribute('href', '/dashboard/reports/order-info')
    })

    it('有 live-stream 数据时渲染今日出单列表', () => {
      mockUseLiveStream.mockReturnValue([
        { id: '1:111', title: '项目A $25.00', timeLabel: '10:30' },
        { id: '2:222', title: '项目B $18.50', timeLabel: '10:12' },
      ])
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('项目A $25.00')).toBeInTheDocument()
      expect(screen.getByText('项目B $18.50')).toBeInTheDocument()
      expect(screen.queryByTestId('order-stream-empty')).not.toBeInTheDocument()
    })

    it('useLiveStream 仅在展开时被启用', () => {
      mockUseLiveStream.mockClear()
      const { unmount } = render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={projectBreakdown}
          projects={projects}
        />
      )
      // 折叠态：enabled=false
      expect(mockUseLiveStream).toHaveBeenLastCalledWith(false)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 展开态：enabled=true
      expect(mockUseLiveStream).toHaveBeenLastCalledWith(true)
      unmount()
    })
  })

  describe('边界情况', () => {
    it('currentRows 为空时 pending 显示 ——', () => {
      render(
        <V2OrderFlowPanel
          currentRows={[]}
          projectBreakdown={{}}
          projects={[]}
          loading
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 使用 em dash 占位
      expect(screen.getByText('\u2014\u2014')).toBeInTheDocument()
    })

    it('loading 且无数据时显示骨架', () => {
      const { container } = render(
        <V2OrderFlowPanel
          currentRows={[]}
          projectBreakdown={{}}
          projects={[]}
          loading
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // shadcn Skeleton 渲染为 div
      const skeletons = container.querySelectorAll('.animate-pulse')
      expect(skeletons.length).toBeGreaterThanOrEqual(1)
    })

    it('无 projectBreakdown 时不渲染待处理项目区', () => {
      render(
        <V2OrderFlowPanel
          currentRows={mockRows}
          projectBreakdown={undefined}
          projects={projects}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.queryByText('待处理项目')).not.toBeInTheDocument()
    })
  })
})