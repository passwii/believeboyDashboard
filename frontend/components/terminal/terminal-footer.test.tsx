import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalFooter } from './terminal-footer'

const { tickerMock } = vi.hoisted(() => ({ tickerMock: vi.fn() }))
vi.mock('@/lib/hooks/use-exchange-rate-ticker', () => ({
  useExchangeRateTicker: tickerMock,
}))

const { unreadMock } = vi.hoisted(() => ({ unreadMock: vi.fn() }))
vi.mock('@/components/notifications/server-notifications-context', () => ({
  useServerNotifications: unreadMock,
}))

afterEach(() => {
  cleanup()
  tickerMock.mockReset()
  unreadMock.mockReset()
})

function mockTicker(
  status: 'loading' | 'ok' | 'error',
  ticks: Array<{ currency: string; rate: number | null; yearMonth: string | null }>
) {
  tickerMock.mockReturnValue({ ticks, status, lastSuccessAt: status === 'ok' ? Date.now() : null, refresh: vi.fn() })
  unreadMock.mockReturnValue({ unreadCount: 2 })
}

describe('TerminalFooter', () => {
  it('无数据时汇率显示 "--" 占位且不报错', () => {
    mockTicker('loading', [
      { currency: 'USD', rate: null, yearMonth: null },
      { currency: 'EUR', rate: null, yearMonth: null },
      { currency: 'GBP', rate: null, yearMonth: null },
    ])
    render(<TerminalFooter />)
    expect(screen.getByTestId('terminal-footer')).toBeInTheDocument()
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })

  it('拉取成功后渲染三位汇率并显示同步正常绿点', () => {
    mockTicker('ok', [
      { currency: 'USD', rate: 7.16, yearMonth: '2026-08' },
      { currency: 'EUR', rate: 7.84, yearMonth: '2026-08' },
      { currency: 'GBP', rate: 9.05, yearMonth: '2026-08' },
    ])
    render(<TerminalFooter />)
    // marquee 渲染两份内容（无缝循环），用 getAllByText 断言
    expect(screen.getAllByText('7.1600').length).toBeGreaterThan(0)
    expect(screen.getAllByText('7.8400').length).toBeGreaterThan(0)
    expect(screen.getAllByText('9.0500').length).toBeGreaterThan(0)
    expect(screen.getByText(/同步正常/)).toBeInTheDocument()
    expect(screen.getByTestId('terminal-sync-dot').className).toContain('bg-term-pos')
  })

  it('轮询失败时红点 + 同步异常，未读徽标独立展示', () => {
    mockTicker('error', [
      { currency: 'USD', rate: null, yearMonth: null },
      { currency: 'EUR', rate: null, yearMonth: null },
      { currency: 'GBP', rate: null, yearMonth: null },
    ])
    render(<TerminalFooter />)
    expect(screen.getByText('同步异常')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-sync-dot').className).toContain('bg-term-neg')
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
