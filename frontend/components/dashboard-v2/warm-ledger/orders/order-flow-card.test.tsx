import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'
import type { PendingOrderItem } from '@/components/dashboard-v2/use-pending-orders'

import { OrderFlowCard, type OrderFlowCardProps } from './order-flow-card'

const order: PendingOrderItem = {
  id: 12,
  project_id: 4,
  project_name: 'Northstar Goods',
  amazon_order_id: '114-1234567-1234567',
  sku: 'NS-TRAVEL-MUG-BLACK',
  asin: 'B000000000',
  product_name: 'Travel mug',
  quantity: 2,
  item_price: 24.5,
  shipping_price: 0,
  currency: 'USD',
  country: 'US',
  purchase_at_utc: '2026-10-31T18:00:00Z',
  purchase_at_pt: '2026-10-31 11:00:00',
  order_status: 'Pending',
}

const baseProps: OrderFlowCardProps = {
  pendingCount: 1,
  countLoading: false,
  items: [order],
  listLoading: false,
  hasMore: false,
}

describe('OrderFlowCard', () => {
  it('announces count loading while preserving the count slot', () => {
    render(<OrderFlowCard {...baseProps} pendingCount={0} countLoading />)

    expect(screen.getByRole('status', { name: 'Pending 总数加载中' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(screen.getByRole('status', { name: 'Pending 总数加载中' })).toHaveTextContent('—')
  })

  it('shows list loading separately from the supplied Pending count', () => {
    render(<OrderFlowCard {...baseProps} pendingCount={12} listLoading />)

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '待处理订单加载中' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(screen.queryByText('当前没有待处理订单')).not.toBeInTheDocument()
  })

  it('shows an explicit empty state and keeps a real zero count', () => {
    render(<OrderFlowCard {...baseProps} pendingCount={0} items={[]} />)

    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('当前没有待处理订单')).toBeInTheDocument()
  })

  it('announces list failures as actionable errors', () => {
    render(<OrderFlowCard {...baseProps} items={[]} listError="待处理订单加载失败" />)

    expect(screen.getByRole('alert')).toHaveTextContent('待处理订单加载失败')
    expect(screen.queryByText('当前没有待处理订单')).not.toBeInTheDocument()
  })

  it('announces count failures independently from list state', () => {
    render(<OrderFlowCard {...baseProps} countError="Pending 总数暂不可用" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Pending 总数暂不可用')
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
    expect(screen.getByText('114-1234567-1234567')).toBeInTheDocument()
  })

  it('announces a shared request failure and loading state only once', () => {
    const { rerender } = render(
      <OrderFlowCard
        {...baseProps}
        pendingCount={0}
        countLoading
        listLoading
        countError="同一请求失败"
        listError="同一请求失败"
      />
    )

    expect(screen.getByRole('status', { name: 'Pending 总数加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '待处理订单加载中' })).not.toBeInTheDocument()

    rerender(
      <OrderFlowCard
        {...baseProps}
        items={[]}
        countError="同一请求失败"
        listError="同一请求失败"
      />
    )
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('shows and invokes load more only when the list has another page', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn()
    render(<OrderFlowCard {...baseProps} hasMore loadMore={loadMore} />)

    await user.click(screen.getByRole('button', { name: '加载更多待处理订单' }))

    expect(loadMore).toHaveBeenCalledOnce()
  })

  it('does not show an inactive load-more control when either paging input is absent', () => {
    const loadMore = vi.fn()
    const { rerender } = render(<OrderFlowCard {...baseProps} hasMore />)

    expect(screen.queryByRole('button', { name: '加载更多待处理订单' })).not.toBeInTheDocument()

    rerender(<OrderFlowCard {...baseProps} hasMore={false} loadMore={loadMore} />)
    expect(screen.queryByRole('button', { name: '加载更多待处理订单' })).not.toBeInTheDocument()
  })

  it('wraps long Order IDs and SKUs without truncating their accessible text', () => {
    const longOrderId = '123-4567890-12345678901234567890'
    const longSku = 'EXTRA-LONG-SKU-'.repeat(8)
    const longOrder = { ...order, amazon_order_id: longOrderId, sku: longSku }

    render(<OrderFlowCard {...baseProps} items={[longOrder]} />)

    const orderId = screen.getByText(longOrderId)
    const sku = screen.getByText(longSku)
    expect(orderId).toHaveAttribute('title', longOrderId)
    expect(orderId).toHaveStyle({ overflowWrap: 'anywhere' })
    expect(sku).toHaveAttribute('title', longSku)
    expect(sku).toHaveStyle({ overflowWrap: 'anywhere' })
  })

  it('does not render project groups from order rows when complete totals are absent', () => {
    const { container } = render(<OrderFlowCard {...baseProps} />)

    expect(container.querySelector('details')).not.toBeInTheDocument()
    expect(screen.getByText('Northstar Goods')).toBeInTheDocument()
  })

  it('does not render project groups when the supplied totals are incomplete', () => {
    const props: OrderFlowCardProps = {
      ...baseProps,
      projectGrouping: {
        totalsAreComplete: false,
        projects: [{ projectId: 4, projectName: 'Northstar Goods', total: 8 }],
      },
    }
    const { container } = render(<OrderFlowCard {...props} />)

    expect(container.querySelector('details')).not.toBeInTheDocument()
  })

  it('keeps optional complete project groups collapsed initially', () => {
    const props: OrderFlowCardProps = {
      ...baseProps,
      projectGrouping: {
        totalsAreComplete: true,
        projects: [{ projectId: 4, projectName: 'Northstar Goods', total: 8 }],
      },
    }
    const { container } = render(<OrderFlowCard {...props} />)

    const group = container.querySelector('details')
    expect(group).toBeInTheDocument()
    expect(group).not.toHaveAttribute('open')
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('renders live events only when the optional data is supplied', () => {
    const event: LiveStreamItem = { id: 'evt-1', title: 'Travel mug · $24.50', timeLabel: '刚刚' }
    const { rerender } = render(<OrderFlowCard {...baseProps} liveEvents={[event]} />)

    expect(screen.getByText('今日出单')).toBeInTheDocument()
    expect(screen.getByText('Travel mug · $24.50')).toBeInTheDocument()
    expect(screen.getByText('刚刚')).toBeInTheDocument()

    rerender(<OrderFlowCard {...baseProps} />)
    expect(screen.queryByText('今日出单')).not.toBeInTheDocument()
  })

  it('makes live events keyboard-operable only when a navigation callback exists', async () => {
    const user = userEvent.setup()
    const event: LiveStreamItem = {
      id: '4:114-1234567-1234567',
      title: '订单 #114-1234567-1234567 · USD 24.50',
      timeLabel: '刚刚',
    }
    const onOpenLiveEvent = vi.fn()
    const { rerender } = render(<OrderFlowCard {...baseProps} liveEvents={[event]} />)

    expect(screen.queryByRole('button', { name: /打开订单/ })).not.toBeInTheDocument()

    rerender(
      <OrderFlowCard
        {...baseProps}
        liveEvents={[event]}
        onOpenLiveEvent={onOpenLiveEvent}
      />
    )
    const button = screen.getByRole('button', { name: /打开订单/ })
    await user.click(button)
    expect(onOpenLiveEvent).toHaveBeenCalledWith(event)
  })

  it('makes order rows keyboard-operable only when onOpenOrder is provided', async () => {
    const user = userEvent.setup()
    const onOpenOrder = vi.fn()
    const { rerender } = render(<OrderFlowCard {...baseProps} />)

    expect(screen.queryByRole('button', { name: /114-1234567-1234567/ })).not.toBeInTheDocument()

    rerender(<OrderFlowCard {...baseProps} onOpenOrder={onOpenOrder} />)
    const row = screen.getByRole('button', { name: /114-1234567-1234567/ })
    await user.tab()
    expect(row).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(onOpenOrder).toHaveBeenCalledWith(order)
  })
})
