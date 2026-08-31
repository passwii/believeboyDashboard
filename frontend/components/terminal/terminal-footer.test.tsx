import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalFooter } from './terminal-footer'
import { TERMINAL_TICKER } from './terminal-constants'

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

const { alertMock } = vi.hoisted(() => ({ alertMock: vi.fn() }))
vi.mock('@/lib/hooks/use-inventory-alert', () => ({
  useInventoryAlert: alertMock,
}))
const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }))
vi.mock('@/lib/hooks/use-report-upload-status', () => ({
  useReportUploadStatus: uploadMock,
}))

// 默认：库存预警频道加载中（不渲染具体数字），保证其余用例不被影响
alertMock.mockReturnValue({ count: null, status: 'loading' })
// 默认：报表上传完成度加载中（频道不渲染），保证其余用例不被影响
uploadMock.mockReturnValue({ uploaded: null, total: null, missing: null, status: 'loading' })

function mockAlert(count: number | null, status: 'loading' | 'ok' | 'error' = 'ok') {
  alertMock.mockReturnValue({ count, status })
}

function mockUpload(
  counts: { uploaded: number | null; total: number | null; missing: number | null },
  status: 'loading' | 'ok' | 'error' = 'ok'
) {
  uploadMock.mockReturnValue({ ...counts, status })
}

afterEach(() => {
  cleanup()
  tickerMock.mockReset()
  briefMock.mockReset()
  unreadMock.mockReset()
  alertMock.mockReset().mockReturnValue({ count: null, status: 'loading' })
  uploadMock
    .mockReset()
    .mockReturnValue({ uploaded: null, total: null, missing: null, status: 'loading' })
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

function mockBrief(
  brief: Partial<{
    gmv: number | null
    orders: number | null
    pending: number | null
    adSpend: number | null
    adOrders: number | null
    gmvDoD: number | null
    gmvWoW: number | null
    ordersDoD: number | null
    ordersWoW: number | null
    latestSalesDate: string | null
  }>,
  status: 'ok' | 'error' = 'ok'
) {
  briefMock.mockReturnValue({
    brief: {
      gmv: null,
      orders: null,
      pending: null,
      adSpend: null,
      adOrders: null,
      gmvDoD: null,
      gmvWoW: null,
      ordersDoD: null,
      ordersWoW: null,
      latestSalesDate: null,
      ...brief,
    },
    status,
  })
}

describe('TerminalFooter BLF-921 Stage 2：数据可信度频道', () => {
  it('报表上传缺口时渲染「报表 N/M」并以 text-term-warn 高亮（双拷贝）', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockUpload({ uploaded: 20, total: 21, missing: 1 })
    render(<TerminalFooter />)
    const reportEls = screen.getAllByText('20/21')
    expect(reportEls.length).toBeGreaterThan(0)
    expect(reportEls[0].className).toContain('text-term-warn')
    // label「报表」也双拷贝渲染
    expect(screen.getAllByText('报表').length).toBeGreaterThan(0)
  })

  it('报表全齐（21/21）时频道不渲染', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockUpload({ uploaded: 21, total: 21, missing: 0 })
    render(<TerminalFooter />)
    expect(screen.queryByText('报表')).toBeNull()
    expect(screen.queryByText('21/21')).toBeNull()
  })

  it('数据新鲜度：latestSalesDate 渲染「数据至 MM-DD」（双拷贝）', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3, latestSalesDate: '2026-08-30' })
    render(<TerminalFooter />)
    const freshEls = screen.getAllByText('08-30')
    expect(freshEls.length).toBeGreaterThan(0)
    expect(screen.getAllByText('数据至').length).toBeGreaterThan(0)
  })

  it('开关关闭时两频道均不渲染（契约断言，BLF-840 范式）', () => {
    const channels = TERMINAL_TICKER.channels as Record<string, boolean>
    const prev = { ...channels }
    channels.uploadStatus = false
    channels.dataFreshness = false
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3, latestSalesDate: '2026-08-30' })
      mockUpload({ uploaded: 20, total: 21, missing: 1 })
      render(<TerminalFooter />)
      expect(screen.queryByText('报表')).toBeNull()
      expect(screen.queryByText('20/21')).toBeNull()
      expect(screen.queryByText('数据至')).toBeNull()
      expect(screen.queryByText('08-30')).toBeNull()
    } finally {
      Object.assign(channels, prev)
    }
  })
})

describe('TerminalFooter BLF-920 Stage 1：快报环比与广告数字', () => {
  it('GMV/订单渲染 DoD 环比箭头着色（▲绿/▼红）+ WoW 周环比 + 广告数字', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({
      gmv: 12345,
      orders: 42,
      pending: 3,
      adSpend: 80,
      adOrders: 5,
      gmvDoD: 20,
      gmvWoW: 9.09,
      ordersDoD: -5,
      ordersWoW: null,
    })
    render(<TerminalFooter />)
    // GMV 环比：▲20%（涨绿）
    const gmvUp = screen.getAllByText('▲20%')
    expect(gmvUp.length).toBeGreaterThan(0)
    expect(gmvUp[0].className).toContain('text-term-pos')
    // 订单环比：▼5%（跌红）
    const ordersDown = screen.getAllByText('▼5%')
    expect(ordersDown.length).toBeGreaterThan(0)
    expect(ordersDown[0].className).toContain('text-term-neg')
    // WoW 周环比带「周」标记；ordersWoW null → 「—」
    const gmvWow = screen.getAllByText('周▲9%')
    expect(gmvWow.length).toBeGreaterThan(0)
    expect(gmvWow[0].className).toContain('text-term-pos')
    const ordersWow = screen.getAllByText('周—')
    expect(ordersWow.length).toBeGreaterThan(0)
    expect(ordersWow[0].className).toContain('text-term-faint')
    // 广告花费 + 广告订单
    expect(screen.getAllByText('$80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('5').length).toBeGreaterThan(0)
    // 中文标签不 mono（BLF-832 A5）
    for (const label of ['广告', '广告单']) {
      const el = screen.getAllByText(label)[0]
      expect(el.className).not.toContain('font-mono')
    }
  })

  it('briefReady 为 false 时环比与广告全部 "--" 不崩溃', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: null, orders: null, pending: null }, 'error')
    render(<TerminalFooter />)
    expect(screen.getByTestId('terminal-footer')).toBeInTheDocument()
    // 降级占位：全部数值 '--'（数量随字段增加，只断言存在）
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })
})

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

  it('BLF-832 A5：数值 span 含 font-mono，中文标签不含（去整条 mono）', () => {
    mockTicker('ok', [
      { currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: 1.2 },
    ])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    render(<TerminalFooter />)

    const footer = screen.getByTestId('terminal-footer')
    // 整条 footer 不再 mono
    expect(footer.className).not.toContain('font-mono')
    // 数值 span：mono + tabular-nums
    for (const value of ['7.1600', '$12,345']) {
      const el = screen.getAllByText(value)[0]
      expect(el.className).toContain('font-mono')
      expect(el.className).toContain('tabular-nums')
    }
    // 中文标签：不含 mono
    for (const label of ['GMV', '订单']) {
      const el = screen.getAllByText(label)[0]
      expect(el.className).not.toContain('font-mono')
    }
  })

  it('BLF-840 库存预警频道按约定渲染：label + 数量 + 风险高亮', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlert(3, 'ok')
    render(<TerminalFooter />)
    // 双拷贝：label 与风险文案各出现两次
    expect(screen.getAllByText('库存预警').length).toBeGreaterThan(0)
    const riskEls = screen.getAllByText('3 SKU 低于安全库存')
    expect(riskEls.length).toBeGreaterThan(0)
    // 风险态（count>0）高亮为 term-neg
    expect(riskEls[0].className).toContain('text-term-neg')
  })

  it('BLF-840 库存预警频道无风险时显示「正常」且低调（faint）', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlert(0, 'ok')
    render(<TerminalFooter />)
    const okEls = screen.getAllByText('正常')
    expect(okEls.length).toBeGreaterThan(0)
    expect(okEls[0].className).toContain('text-term-faint')
  })

  it('BLF-848：双拷贝拼接处 changelog 与 fx 间存在分隔符（修复边界粘连）', async () => {
    // 仅开 fx + changelog 两频道，使 copy 边界正好是 changelog → fx
    const channels = TERMINAL_TICKER.channels as Record<string, boolean>
    const prev = { ...channels }
    channels.fx = true
    channels.dailyBrief = false
    channels.syncTime = false
    channels.changelog = true
    channels.inventoryAlert = false
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      // dailyBrief 频道虽关闭，hook 仍被无条件调用，需提供返回值
      mockBrief({ gmv: null, orders: null, pending: null }, 'error')
      // 模拟 changelog 端点成功返回
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: 'V7', summary: '库存预警频道上线' }),
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<TerminalFooter />)
      // 等待 changelog 异步到位（双拷贝，故用 findAll）
      await screen.findAllByText('V7')
      // 双拷贝：更新标签出现两次
      expect(screen.getAllByText('更新').length).toBe(2)
      // 分隔符 │（text-term-border）应 = 3：
      //  copy0: fx │ changelog（1 个）
      //  copy1: │ fx │ changelog（2 个，含边界 changelog→fx）
      // 修复前仅 2 个（边界无 │，两频道粘连）
      const separators = screen.getAllByText('│')
      expect(separators.length).toBe(3)
      for (const sep of separators) {
        expect(sep.className).toContain('text-term-border')
      }
    } finally {
      vi.unstubAllGlobals()
      Object.assign(channels, prev)
    }
  })

  it('BLF-840 频道开关关闭时库存预警不渲染（契约断言）', () => {
    const channels = TERMINAL_TICKER.channels as { inventoryAlert: boolean }
    const prev = channels.inventoryAlert
    channels.inventoryAlert = false
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3 })
      mockAlert(3, 'ok')
      render(<TerminalFooter />)
      expect(screen.queryByText('库存预警')).toBeNull()
    } finally {
      channels.inventoryAlert = prev
    }
  })
})
