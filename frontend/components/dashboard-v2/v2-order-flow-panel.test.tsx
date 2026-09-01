import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock useLiveStream — 默认返回空数组（无今日出单事件）
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'

const mockUseLiveStream = vi.fn<(enabled: boolean) => LiveStreamItem[]>(() => [])

vi.mock('@/components/terminal/use-live-stream', () => ({
  useLiveStream: (...args: Parameters<typeof mockUseLiveStream>) => mockUseLiveStream(...args),
}))

// mock usePendingOrders — BLF-927 订单级 pending 列表数据源（默认空态）
const mockUsePendingOrders = vi.fn(() => ({
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  loadMore: vi.fn(),
}))

vi.mock('@/components/dashboard-v2/use-pending-orders', () => ({
  usePendingOrders: (...args: unknown[]) => mockUsePendingOrders(...(args as [])),
}))

// mock next/navigation router（行点击跳转断言用）
const mockRouterPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn() }),
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

/** 面板公共 props（BLF-927 起必填 dateFrom/dateTo） */
const panelProps = {
  currentRows: mockRows,
  projectBreakdown,
  projects,
  dateFrom: '2026-08-25',
  dateTo: '2026-08-31',
}

describe('V2OrderFlowPanel', () => {
  beforeEach(() => {
    mockUseLiveStream.mockReturnValue([])
    mockUsePendingOrders.mockReset()
    mockUsePendingOrders.mockReturnValue({
      items: [],
      total: 0,
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      loadMore: vi.fn(),
    })
    mockRouterPush.mockClear()
    // 默认 localStorage 无值 → 折叠态
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    })
  })

  describe('折叠态（默认）', () => {
    it('渲染折叠窄条', () => {
      render(
        <V2OrderFlowPanel {...panelProps} />
      )
      expect(screen.getByText('订单流')).toBeInTheDocument()
      expect(screen.getByLabelText('展开订单流面板')).toBeInTheDocument()
    })

    it('显示待处理计数徽标（最后一行 pending_order_qty = 7）', () => {
      render(
        <V2OrderFlowPanel {...panelProps} />
      )
      expect(screen.getByText('7')).toBeInTheDocument()
    })

    it('pending 为 0 时不显示徽标', () => {
      render(
        <V2OrderFlowPanel
          {...panelProps}
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
          {...panelProps}
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
        <V2OrderFlowPanel {...panelProps} />
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
        <V2OrderFlowPanel {...panelProps} />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      fireEvent.click(screen.getByLabelText('收起订单流面板'))
      expect(screen.getByLabelText('展开订单流面板')).toBeInTheDocument()
      expect(screen.queryByLabelText('收起订单流面板')).not.toBeInTheDocument()
    })

    it('展开时显示待处理件数 = 最新 pending_order_qty', () => {
      render(
        <V2OrderFlowPanel {...panelProps} />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 最后一行 pending_order_qty = 7（头部徽标 + 摘要 + 项目分解出现多次，取摘要区的第一个）
      expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('件待处理')).toBeInTheDocument()
    })

    it('项目分解按 pending 排序取 Top 5', () => {
      render(
        <V2OrderFlowPanel {...panelProps} />
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
        <V2OrderFlowPanel {...panelProps} />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('今日出单')).toBeInTheDocument()
      // 空态：无 live-stream 数据
      expect(screen.getByTestId('order-stream-empty')).toBeInTheDocument()
    })

    it('底部链接指向订单信息页', () => {
      render(
        <V2OrderFlowPanel {...panelProps} />
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
        <V2OrderFlowPanel {...panelProps} />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('项目A $25.00')).toBeInTheDocument()
      expect(screen.getByText('项目B $18.50')).toBeInTheDocument()
      expect(screen.queryByTestId('order-stream-empty')).not.toBeInTheDocument()
    })

    it('useLiveStream 仅在展开时被启用', () => {
      mockUseLiveStream.mockClear()
      const { unmount } = render(
        <V2OrderFlowPanel {...panelProps} />
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
          {...panelProps}
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
          {...panelProps}
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
          {...panelProps}
          projectBreakdown={undefined}
        />
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.queryByText('待处理项目')).not.toBeInTheDocument()
    })
  })

  describe('订单级 pending 列表（BLF-927 Stage 2）', () => {
    const pendingItem = {
      id: 101,
      amazon_order_id: '111-1111111-0000001',
      sku: 'SKU-TEST-LONG-NAME',
      asin: 'B0TEST0001',
      product_name: '测试商品A',
      quantity: 2,
      item_price: 10,
      shipping_price: 5,
      currency: 'USD',
      country: 'US',
      purchase_at_utc: '2026-08-30T02:30:00Z',
      purchase_at_pt: '2026-08-29 19:30:00',
      order_status: 'Pending',
    }

    it('usePendingOrders 仅在展开时被启用，且传入项目列表与日期窗口', () => {
      mockUsePendingOrders.mockClear()
      render(<V2OrderFlowPanel {...panelProps} />)
      // 折叠态：enabled=false
      expect(mockUsePendingOrders).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: false })
      )
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      // 展开态：enabled=true + 项目 + 日期窗口（BEL-422 护栏参数）
      expect(mockUsePendingOrders).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          projectIds: [1, 2, 3, 4],
          dateFrom: '2026-08-25',
          dateTo: '2026-08-31',
        })
      )
    })

    it('渲染待处理订单行（SKU / 国家 / PT 时间 / 金额 / warn 语义色状态）', () => {
      mockUsePendingOrders.mockReturnValue({
        items: [pendingItem],
        total: 1,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: false,
        loadMore: vi.fn(),
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText('待处理订单')).toBeInTheDocument()
      // SKU + 国家·PT 时间（窄列压缩格式 MM-DD HH:MM）
      expect(screen.getByText('SKU-TEST-LONG-NAME')).toBeInTheDocument()
      expect(screen.getByText('US · 08-29 19:30')).toBeInTheDocument()
      // 金额 = item_price + shipping_price（15.00 USD，与 order-info 同口径）
      expect(screen.getByText('15.00 USD')).toBeInTheDocument()
      // 状态标签 warn 语义色 + 数量
      const status = screen.getByText('×2 · 处理中')
      expect(status.className).toContain('text-term-warn')
      expect(status.className).toContain('border-term-warn/50')
    })

    it('加载中显示骨架（aria-busy）', () => {
      mockUsePendingOrders.mockReturnValue({
        items: [],
        total: 0,
        loading: true,
        loadingMore: false,
        error: null,
        hasMore: false,
        loadMore: vi.fn(),
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      const section = screen.getByTestId('order-flow-pending-list')
      expect(section.querySelector('[aria-busy="true"]')).not.toBeNull()
    })

    it('请求失败显示 ERR 提示', () => {
      mockUsePendingOrders.mockReturnValue({
        items: [],
        total: 0,
        loading: false,
        loadingMore: false,
        error: '待处理订单加载失败 (500)',
        hasMore: false,
        loadMore: vi.fn(),
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByText(/ERR · 待处理订单加载失败 \(500\)/)).toBeInTheDocument()
    })

    it('空数据显示空态文案', () => {
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.getByTestId('order-flow-pending-empty')).toBeInTheDocument()
      expect(screen.getByText('当前区间暂无待处理订单')).toBeInTheDocument()
    })

    it('有更多数据时显示「加载更多」并回调 loadMore', () => {
      const loadMore = vi.fn()
      mockUsePendingOrders.mockReturnValue({
        items: [pendingItem],
        total: 25,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: true,
        loadMore,
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      const moreBtn = screen.getByTestId('order-flow-pending-more')
      expect(moreBtn).toHaveTextContent('加载更多（1/25）')
      fireEvent.click(moreBtn)
      expect(loadMore).toHaveBeenCalledTimes(1)
    })

    it('hasMore=false 时不显示加载更多按钮', () => {
      mockUsePendingOrders.mockReturnValue({
        items: [pendingItem],
        total: 1,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: false,
        loadMore: vi.fn(),
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      expect(screen.queryByTestId('order-flow-pending-more')).not.toBeInTheDocument()
    })

    it('行点击跳转 order-info 页并预填 Pending 筛选', () => {
      mockUsePendingOrders.mockReturnValue({
        items: [pendingItem],
        total: 1,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: false,
        loadMore: vi.fn(),
      })
      render(<V2OrderFlowPanel {...panelProps} />)
      fireEvent.click(screen.getByLabelText('展开订单流面板'))
      fireEvent.click(
        screen.getByRole('row', { name: /待处理订单 111-1111111-0000001/ })
      )
      expect(mockRouterPush).toHaveBeenCalledWith(
        '/dashboard/reports/order-info?order_statuses=Pending'
      )
    })
  })
})