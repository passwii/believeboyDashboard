'use client'

import type { CSSProperties } from 'react'

import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'
import type { PendingOrderItem } from '@/components/dashboard-v2/use-pending-orders'
import { getOrderStatusLabel, getOrderStatusTone } from '@/lib/order-status'
import { WarmButton } from '../controls'

export interface CompleteProjectPendingTotal {
  projectId: number
  projectName: string
  /** Complete API total for this project, never derived from the loaded page. */
  total: number
}

export interface ProjectPendingGrouping {
  /** Set true only when totals cover every project in the current scope. */
  totalsAreComplete: boolean
  projects: readonly CompleteProjectPendingTotal[]
}

export interface OrderFlowCardProps {
  pendingCount: number
  countLoading: boolean
  countError?: string | null
  items: readonly PendingOrderItem[]
  listLoading: boolean
  listError?: string | null
  hasMore: boolean
  loadMore?: () => void
  liveEvents?: readonly LiveStreamItem[]
  /** Pass only complete per-project totals from an API with that contract. */
  projectGrouping?: ProjectPendingGrouping
  onOpenOrder?: (order: PendingOrderItem) => void
  onOpenLiveEvent?: (event: LiveStreamItem) => void
}

const statusColors: Record<ReturnType<typeof getOrderStatusTone>, string> = {
  pos: 'var(--warm-ledger-color-positive)',
  warn: 'var(--warm-ledger-color-accent)',
  neg: 'var(--warm-ledger-color-negative)',
  muted: 'var(--warm-ledger-color-text-soft)',
}

const cardStyle: CSSProperties = {
  backgroundColor: 'var(--warm-ledger-color-panel)',
  borderColor: 'var(--warm-ledger-color-hairline)',
  borderRadius: 'var(--warm-ledger-radius-panel)',
  color: 'var(--warm-ledger-color-text)',
  fontFamily: 'var(--warm-ledger-font-sans)',
}

function formatAmount(order: PendingOrderItem): string {
  const amount = order.item_price + order.shipping_price
  const formatted = amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return order.currency ? `${formatted} ${order.currency}` : formatted
}

function formatPtDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!match) return value || '—'
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]} PT`
}

function hasCompleteProjectCoverage(
  items: readonly PendingOrderItem[],
  totals: readonly CompleteProjectPendingTotal[] | undefined
): totals is readonly CompleteProjectPendingTotal[] {
  return Boolean(
    totals?.length &&
      items.length &&
      items.every((item) => totals.some((project) => project.projectId === item.project_id))
  )
}

function OrderDetails({ order }: { order: PendingOrderItem }) {
  const orderIdStyle: CSSProperties = {
    color: 'var(--warm-ledger-color-text)',
    fontFamily: 'var(--warm-ledger-font-mono)',
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  }
  const secondaryTextStyle: CSSProperties = {
    color: 'var(--warm-ledger-color-text-soft)',
  }
  const statusTone = getOrderStatusTone(order.order_status)

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span
          className="min-w-0 break-words text-sm"
          style={orderIdStyle}
          title={order.amazon_order_id}
        >
          {order.amazon_order_id}
        </span>
        <span className="shrink-0 text-xs tabular-nums" style={secondaryTextStyle}>
          {formatPtDate(order.purchase_at_pt)}
        </span>
      </div>

      {order.product_name && (
        <span className="break-words text-sm" style={secondaryTextStyle}>
          {order.product_name}
        </span>
      )}

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span
          className="min-w-0 break-words"
          style={{ ...secondaryTextStyle, overflowWrap: 'anywhere' }}
          title={order.sku ?? undefined}
        >
          {order.sku ?? '—'}
        </span>
        <span className="shrink-0 tabular-nums" style={secondaryTextStyle}>
          ×{order.quantity}
        </span>
        <span
          className="shrink-0 tabular-nums"
          style={{
            color: 'var(--warm-ledger-color-text)',
            fontFamily: 'var(--warm-ledger-font-mono)',
          }}
        >
          {formatAmount(order)}
        </span>
        <span className="shrink-0" style={{ color: statusColors[statusTone] }}>
          {getOrderStatusLabel(order.order_status)}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs" style={secondaryTextStyle}>
        <span>{order.project_name}</span>
        <span>{order.country}</span>
      </div>
    </div>
  )
}

function PendingOrderRow({
  order,
  onOpenOrder,
}: {
  order: PendingOrderItem
  onOpenOrder?: (order: PendingOrderItem) => void
}) {
  const content = <OrderDetails order={order} />

  return (
    <li
      className="border-b last:border-b-0"
      style={{ borderColor: 'var(--warm-ledger-color-hairline)' }}
    >
      {onOpenOrder ? (
        <WarmButton
          type="button"
          variant="quiet"
          onClick={() => onOpenOrder(order)}
          className="w-full text-left"
          style={{
            display: 'block',
            minHeight: 'var(--warm-ledger-control-target-touch)',
            padding: 'var(--warm-ledger-space-3) var(--warm-ledger-space-4)',
            borderRadius: 'var(--warm-ledger-radius-inner)',
            textAlign: 'left',
          }}
        >
          {content}
        </WarmButton>
      ) : (
        <article className="px-4 py-3">{content}</article>
      )}
    </li>
  )
}

function PendingOrderList({
  items,
  onOpenOrder,
}: {
  items: readonly PendingOrderItem[]
  onOpenOrder?: (order: PendingOrderItem) => void
}) {
  return (
    <ul aria-label="待处理订单列表" className="min-w-0">
      {items.map((item) => (
        <PendingOrderRow key={item.id} order={item} onOpenOrder={onOpenOrder} />
      ))}
    </ul>
  )
}

function GroupedPendingOrderList({
  items,
  totals,
  onOpenOrder,
}: {
  items: readonly PendingOrderItem[]
  totals: readonly CompleteProjectPendingTotal[]
  onOpenOrder?: (order: PendingOrderItem) => void
}) {
  return (
    <div>
      {totals.map((project) => {
        const projectItems = items.filter((item) => item.project_id === project.projectId)
        return (
          <details
            key={project.projectId}
            className="border-b last:border-b-0"
            style={{ borderColor: 'var(--warm-ledger-color-hairline)' }}
          >
            <summary
              aria-label={`${project.projectName}，${project.total} 单待处理`}
              className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--warm-ledger-color-accent-strong)] [&::-webkit-details-marker]:hidden"
            >
              <span className="min-w-0 break-words">{project.projectName}</span>
              <span
                className="shrink-0 tabular-nums"
                style={{
                  color: 'var(--warm-ledger-color-accent)',
                  fontFamily: 'var(--warm-ledger-font-mono)',
                }}
              >
                {project.total}
              </span>
            </summary>
            {projectItems.length > 0 ? (
              <PendingOrderList items={projectItems} onOpenOrder={onOpenOrder} />
            ) : (
              <p className="px-4 pb-3 text-xs" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
                该项目暂无已加载订单明细
              </p>
            )}
          </details>
        )
      })}
    </div>
  )
}

export function OrderFlowCard({
  pendingCount,
  countLoading,
  countError,
  items,
  listLoading,
  listError,
  hasMore,
  loadMore,
  liveEvents,
  projectGrouping,
  onOpenOrder,
  onOpenLiveEvent,
}: OrderFlowCardProps) {
  const completeProjectTotals = projectGrouping?.totalsAreComplete
    ? projectGrouping.projects
    : undefined
  const projectTotals = hasCompleteProjectCoverage(items, completeProjectTotals)
    ? completeProjectTotals
    : undefined

  return (
    <section
      aria-label="订单流"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border"
      style={cardStyle}
    >
      <header
        className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b px-5 py-4"
        style={{ borderColor: 'var(--warm-ledger-color-hairline)' }}
      >
        <h2 className="text-base font-medium">订单流</h2>
        <div className="flex items-baseline gap-2">
          {countLoading ? (
            <span
              role="status"
              aria-label="待处理订单总数加载中"
              aria-busy="true"
              className="font-mono text-2xl tabular-nums"
            >
              —
              <span className="ml-2 text-xs" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
                读取中
              </span>
            </span>
          ) : countError ? (
            <span
              className="font-mono text-2xl tabular-nums"
              style={{ color: 'var(--warm-ledger-color-text-soft)' }}
            >
              —
            </span>
          ) : (
            <span
              className="font-mono text-2xl tabular-nums"
              style={{ color: 'var(--warm-ledger-color-accent)', fontFamily: 'var(--warm-ledger-font-mono)' }}
              aria-live="polite"
              aria-atomic="true"
            >
              {pendingCount}
            </span>
          )}
          <span className="text-xs" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
            单
          </span>
        </div>
      </header>

      {countError && (
        <p role="alert" className="shrink-0 border-b px-5 py-3 text-sm" style={{ borderColor: 'var(--warm-ledger-color-hairline)', color: 'var(--warm-ledger-color-negative)' }}>
          待处理订单总数加载失败：{countError}
        </p>
      )}

      <section
        aria-label="待处理订单"
        aria-busy={listLoading}
        className="min-h-0 flex-1 overflow-y-auto pt-3 [scrollbar-width:thin]"
      >
        {listLoading && (
          <div
            role={countLoading ? undefined : 'status'}
            aria-label={countLoading ? undefined : '待处理订单加载中'}
            aria-busy="true"
            className="px-5 pb-3"
          >
            <p className="text-sm" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
              正在读取待处理订单
            </p>
            {items.length === 0 && (
              <div aria-hidden="true" className="mt-3 flex flex-col gap-2">
                <div
                  className="h-10 rounded-[var(--warm-ledger-radius-inner)]"
                  style={{ backgroundColor: 'var(--warm-ledger-color-raised)' }}
                />
                <div
                  className="h-10 rounded-[var(--warm-ledger-radius-inner)]"
                  style={{ backgroundColor: 'var(--warm-ledger-color-raised)' }}
                />
              </div>
            )}
          </div>
        )}

        {listError && listError !== countError && (
          <p role="alert" className="mx-5 mb-3 text-sm" style={{ color: 'var(--warm-ledger-color-negative)' }}>
            待处理订单加载失败：{listError}
          </p>
        )}

        {items.length > 0 ? (
          projectTotals ? (
            <GroupedPendingOrderList
              items={items}
              totals={projectTotals}
              onOpenOrder={onOpenOrder}
            />
          ) : (
            <PendingOrderList items={items} onOpenOrder={onOpenOrder} />
          )
        ) : !listLoading && !listError ? (
          <p className="px-5 pb-5 text-sm" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
            当前没有待处理订单
          </p>
        ) : null}

        {hasMore && loadMore && (
          <div className="border-t px-5 py-3" style={{ borderColor: 'var(--warm-ledger-color-hairline)' }}>
            <WarmButton
              onClick={loadMore}
              disabled={listLoading}
              aria-label="加载更多待处理订单"
              variant="secondary"
              className="w-full"
              style={{ borderColor: 'var(--warm-ledger-color-hairline-strong)' }}
            >
              加载更多
            </WarmButton>
          </div>
        )}
      </section>

      {liveEvents !== undefined && (
        <section
          aria-label="今日出单"
          className="max-h-40 shrink-0 overflow-y-auto border-t px-5 py-4 [scrollbar-width:thin]"
          style={{ borderColor: 'var(--warm-ledger-color-hairline)' }}
        >
          <h3 className="text-sm font-medium">今日出单</h3>
          {liveEvents.length === 0 ? (
            <p className="pt-2 text-sm" style={{ color: 'var(--warm-ledger-color-text-soft)' }}>
              今日暂无出单
            </p>
          ) : (
            <ul aria-label="今日出单列表" className="mt-2">
              {liveEvents.map((event) => (
                <li
                  key={event.id}
                  className="min-w-0"
                >
                  {onOpenLiveEvent ? (
                    <WarmButton
                      variant="quiet"
                      onClick={() => onOpenLiveEvent(event)}
                      aria-label={`打开订单 ${event.title}`}
                      className="flex w-full min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0 py-2 text-left text-sm"
                    >
                      <span className="min-w-0 break-words">{event.title}</span>
                      <span
                        className="shrink-0 text-xs tabular-nums"
                        style={{
                          color: 'var(--warm-ledger-color-text-soft)',
                          fontFamily: 'var(--warm-ledger-font-mono)',
                        }}
                      >
                        {event.timeLabel}
                      </span>
                    </WarmButton>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="min-w-0 break-words">{event.title}</span>
                      <span
                        className="shrink-0 text-xs tabular-nums"
                        style={{
                          color: 'var(--warm-ledger-color-text-soft)',
                          fontFamily: 'var(--warm-ledger-font-mono)',
                        }}
                      >
                        {event.timeLabel}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  )
}
