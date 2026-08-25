import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalFooter } from './terminal-footer'

const { tickerMock } = vi.hoisted(() => ({ tickerMock: vi.fn() }))
vi.mock('@/lib/hooks/use-exchange-rate-ticker', () => ({
  useExchangeRateTicker: tickerMock,
}))

const { briefMock } = vi.hoisted(() => ({ briefMock: vi.fn() }))
vi.mock('@/lib/hooks/use-daily-brief', () => ({
  useDailyBrief: briefMock,
}))

const { unreadMock } = vi.hoisted(() => ({ unreadMock: vi.fn() }))
vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: unreadMock,
}))

afterEach(() => {
  cleanup()
  tickerMock.mockReset()
  briefMock.mockReset()
  unreadMock.mockReset()
})

function mockTicker(
  status: 'loading' | 'ok' | 'error',
  ticks: Array<{
    currency: string
    rate: number | null
    yearMonth: string | null
    changePct?: number | null
  }>
) {
  tickerMock.mockReturnValue({
    ticks: ticks.map((t) => ({ changePct: null, ...t })),
    status,
    lastSuccessAt: status === 'ok' ? Date.now() : null,
    refresh: vi.fn(),
  })
  unreadMock.mockReturnValue({ unreadCount: 2 })
}

function mockBrief(brief: { gmv: number | null; orders: number | null; pending: number | null }, status: 'ok' | 'error' = 'ok') {
  briefMock.mockReturnValue({ brief, status })
}

describe('TerminalFooter', () => {
  it('无数据时汇率与快报显示 "--" 占位且不报错', () => {
    mockTicker('loading', [{ currency: 'USD', rate: null, yearMonth: null }])
    mockBrief({ gmv: null, orders: null, pending: null }, 'error')
    render(<TerminalFooter />)
    expect(screen.getByTestId('terminal-footer')).toBeInTheDocument()
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })

  it('渲染全币种汇率 + 环比着色 + 快报频道，双拷贝无缝内容', () => {
    mockTicker('ok', [
      { currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: 1.2 },
      { currency: 'EUR', rate: 7.84, yearMonth: '2026-08', changePct: -0.8 },
      { currency: 'GBP', rate: 9.05, yearMonth: '2026-08', changePct: null },
      { currency: 'JPY', rate: 0.048, yearMonth: '2026-08', changePct: 0 },
    ])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    render(<TerminalFooter />)
    // 汇率（两份拷贝）
    expect(screen.getAllByText('7.1600').length).toBeGreaterThan(0)
    expect(screen.getAllByText('0.0480').length).toBeGreaterThan(0)
    // 环比涨跌着色（▲绿 / ▼红）
    expect(screen.getAllByText('▲1.20%').length).toBeGreaterThan(0)
    expect(screen.getAllByText('▼0.80%').length).toBeGreaterThan(0)
    // 快报频道
    expect(screen.getAllByText('$12,345').length).toBeGreaterThan(0)
    expect(screen.getAllByText('42').length).toBeGreaterThan(0)
    expect(screen.getByText(/同步正常/)).toBeInTheDocument()
  })

  it('轮询失败时红点 + 同步异常，未读徽标独立展示', () => {
    mockTicker('error', [{ currency: 'USD', rate: null, yearMonth: null }])
    mockBrief({ gmv: null, orders: null, pending: null }, 'error')
    unreadMock.mockReturnValue({ unreadCount: 2 })
    render(<TerminalFooter />)
    expect(screen.getByText('同步异常')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-sync-dot').className).toContain('bg-term-neg')
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('单频道降级不影响其他频道：快报 error 时汇率仍在', () => {
    mockTicker('ok', [
      { currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null },
    ])
    mockBrief({ gmv: null, orders: null, pending: null }, 'error')
    render(<TerminalFooter />)
    expect(screen.getAllByText('7.1600').length).toBeGreaterThan(0)
    // 快报占位不崩溃
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })
})
