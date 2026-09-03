import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalFooter } from './terminal-footer'
import { TERMINAL_TICKER } from './terminal-constants'

const { tickerMock } = vi.hoisted(() => ({ tickerMock: vi.fn() }))
vi.mock('@/lib/hooks/use-exchange-rate-ticker', () => ({
  useExchangeRateTicker: tickerMock,
}))

const { briefMock } = vi.hoisted(() => ({ briefMock: vi.fn() }))
vi.mock('@/lib/hooks/use-seven-day-brief', () => ({
  useSevenDayBrief: briefMock,
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

const { alertStatsMock } = vi.hoisted(() => ({ alertStatsMock: vi.fn() }))
vi.mock('@/lib/hooks/use-alert-stats', () => ({
  useAlertStats: alertStatsMock,
}))

const { presenceMock } = vi.hoisted(() => ({ presenceMock: vi.fn() }))
vi.mock('@/lib/hooks/use-presence-count', () => ({
  usePresenceCount: presenceMock,
}))

// 默认：库存预警频道加载中（不渲染具体数字），保证其余用例不被影响
alertMock.mockReturnValue({ count: null, status: 'loading' })
// 默认：报表上传完成度加载中（频道不渲染），保证其余用例不被影响
uploadMock.mockReturnValue({ uploaded: null, total: null, missing: null, status: 'loading' })
// 默认：告警统计加载中（频道不渲染）
alertStatsMock.mockReturnValue({
  totalActive: null,
  criticalCount: null,
  warningCount: null,
  severity: 'none',
  status: 'loading',
})
// 默认：在线人数加载中（右侧不显示）
presenceMock.mockReturnValue({ online: null, status: 'loading' })

function mockAlert(count: number | null, status: 'loading' | 'ok' | 'error' = 'ok') {
  alertMock.mockReturnValue({ count, status })
}

function mockUpload(
  counts: { uploaded: number | null; total: number | null; missing: number | null },
  status: 'loading' | 'ok' | 'error' = 'ok'
) {
  uploadMock.mockReturnValue({ ...counts, status })
}

function mockAlertStats(
  summary: {
    totalActive: number | null
    criticalCount: number | null
    warningCount: number | null
    severity: 'critical' | 'warning' | 'none'
  },
  status: 'loading' | 'ok' | 'error' = 'ok'
) {
  alertStatsMock.mockReturnValue({ ...summary, status })
}

function mockPresence(online: number | null, status: 'loading' | 'ok' | 'error' = 'ok') {
  presenceMock.mockReturnValue({ online, status })
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
  alertStatsMock
    .mockReset()
    .mockReturnValue({
      totalActive: null,
      criticalCount: null,
      warningCount: null,
      severity: 'none',
      status: 'loading',
    })
  presenceMock.mockReset().mockReturnValue({ online: null, status: 'loading' })
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
    gmvDelta: number | null
    ordersDelta: number | null
    adSpendDelta: number | null
    adOrdersDelta: number | null
    acoas: number | null
    acoasDelta: number | null
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
      gmvDelta: null,
      ordersDelta: null,
      adSpendDelta: null,
      adOrdersDelta: null,
      acoas: null,
      acoasDelta: null,
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

describe('TerminalFooter BLF-950：快报近 7 天聚合与单指标百分比', () => {
  it('GMV/订单/广告/广告单渲染单一环比箭头（▲绿/▼红），无周环比', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({
      gmv: 12345,
      orders: 42,
      pending: 3,
      adSpend: 80,
      adOrders: 5,
      gmvDelta: 20,
      ordersDelta: -5,
      adSpendDelta: null,
      adOrdersDelta: 0,
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
    // 广告花费：无变化 → 无百分比（-- 降级由其它用例覆盖）；广告单持平 0% → '—'
    expect(screen.queryAllByText('周▲9%').length).toBe(0)
    const flat = screen.getAllByText('—')
    expect(flat.length).toBeGreaterThan(0)
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

  it('ACOAS 渲染在广告单之后：值 + pp 差值 + 反向着色', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({
      gmv: 10000,
      adSpend: 500,
      adOrders: 10,
      acoas: 5.0,
      acoasDelta: 2.2,
    })
    render(<TerminalFooter />)
    // ACOAS 标签
    expect(screen.getAllByText('ACOAS').length).toBeGreaterThan(0)
    // ACOAS 值 5.0%
    expect(screen.getAllByText('5.0%').length).toBeGreaterThan(0)
    // ACOAS 环比 ▲2.2pp（上升=标红，反向着色）
    const acoasUp = screen.getAllByText('▲2.2pp')
    expect(acoasUp.length).toBeGreaterThan(0)
    expect(acoasUp[0].className).toContain('text-term-neg')
    // ACOAS 在广告单之后（DOM 位置断言）
    const adOrderLabel = screen.getAllByText('广告单')[0]
    const acoasLabel = screen.getAllByText('ACOAS')[0]
    // eslint-disable-next-line no-bitwise
    expect(adOrderLabel.compareDocumentPosition(acoasLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('ACOAS 下降时标绿（反向着色）', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({
      gmv: 10000,
      adSpend: 500,
      acoas: 5.0,
      acoasDelta: -1.5,
    })
    render(<TerminalFooter />)
    const acoasDown = screen.getAllByText('▼1.5pp')
    expect(acoasDown.length).toBeGreaterThan(0)
    expect(acoasDown[0].className).toContain('text-term-pos')
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

describe('TerminalFooter BLF-922 Stage 3：告警事件频道 + 在线人数', () => {
  it('告警 totalActive 5 / critical 2 → 「告警 5」text-term-neg（双拷贝）', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlertStats({ totalActive: 5, criticalCount: 2, warningCount: 3, severity: 'critical' })
    render(<TerminalFooter />)
    // 数字与 label 分 span 渲染，用 textContent 匹配（BLF-832 A5 数字 mono）
    const alertEls = screen.getAllByText((_, el) => el?.textContent === '告警 5')
    expect(alertEls.length).toBeGreaterThan(0)
    for (const el of alertEls) {
      expect(el.className).toContain('text-term-neg')
    }
  })

  it('告警 totalActive 3 / critical 0（仅 warning）→ text-term-warn', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlertStats({ totalActive: 3, criticalCount: 0, warningCount: 3, severity: 'warning' })
    render(<TerminalFooter />)
    const alertEls = screen.getAllByText((_, el) => el?.textContent === '告警 3')
    expect(alertEls.length).toBeGreaterThan(0)
    for (const el of alertEls) {
      expect(el.className).toContain('text-term-warn')
      expect(el.className).not.toContain('text-term-neg')
    }
  })

  it('告警 totalActive 0 → 频道不渲染', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlertStats({ totalActive: 0, criticalCount: 0, warningCount: 0, severity: 'none' })
    render(<TerminalFooter />)
    expect(screen.queryByText(/告警/)).toBeNull()
  })

  it('告警 hook error → 频道降级隐藏不崩溃', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockAlertStats({ totalActive: null, criticalCount: null, warningCount: null, severity: 'none' }, 'error')
    render(<TerminalFooter />)
    expect(screen.getByTestId('terminal-footer')).toBeInTheDocument()
    expect(screen.queryByText(/告警/)).toBeNull()
  })

  it('在线人数 online 4 → 右侧出现「4 人在线」', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockPresence(4, 'ok')
    render(<TerminalFooter />)
    expect(screen.getAllByText((_, el) => el?.textContent === '4 人在线').length).toBeGreaterThan(0)
  })

  it('在线人数 online null（加载中/失败）→ 右侧不显示', () => {
    mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
    mockBrief({ gmv: 12345, orders: 42, pending: 3 })
    mockPresence(null, 'loading')
    render(<TerminalFooter />)
    expect(screen.queryByText(/人在线/)).toBeNull()
  })

  it('channels.alertEvents = false → 契约断言不渲染（BLF-840 范式）', () => {
    const channels = TERMINAL_TICKER.channels as Record<string, boolean>
    const prev = { ...channels }
    channels.alertEvents = false
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3 })
      mockAlertStats({ totalActive: 5, criticalCount: 2, warningCount: 3, severity: 'critical' })
      render(<TerminalFooter />)
      expect(screen.queryByText(/告警/)).toBeNull()
    } finally {
      Object.assign(channels, prev)
    }
  })
})

describe('TerminalFooter BLF-966：ticker 手动 scrub', () => {
  /** jsdom 无 Web Animations：给 ticker track 挂一个可控动画桩 */
  function stubTickerAnimation(currentTime = 1000) {
    const anim = { currentTime }
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: function (this: HTMLElement) {
        return this?.dataset?.testid === 'terminal-ticker-track' ? [anim] : []
      },
    })
    return anim
  }

  function removeTickerAnimationStub() {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    delete proto['getAnimations']
  }

  function wheelOnViewport(opts: { deltaY: number; shiftKey?: boolean }) {
    const viewport = screen.getByTestId('terminal-ticker-viewport')
    const ev = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: opts.deltaY,
      shiftKey: opts.shiftKey ?? false,
    })
    viewport.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  it('普通滚轮上滑（反向）→ currentTime 回退（回看）并 preventDefault', () => {
    const anim = stubTickerAnimation(1000)
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3 })
      render(<TerminalFooter />)
      expect(wheelOnViewport({ deltaY: -100 })).toBe(true)
      expect(anim.currentTime).toBeLessThan(1000)
    } finally {
      removeTickerAnimationStub()
    }
  })

  it('普通滚轮下滑（正向）→ 被忽略，交给自动滚动（不 preventDefault、不碰 currentTime）', () => {
    const anim = stubTickerAnimation(1000)
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3 })
      render(<TerminalFooter />)
      expect(wheelOnViewport({ deltaY: 100 })).toBe(false)
      expect(anim.currentTime).toBe(1000)
    } finally {
      removeTickerAnimationStub()
    }
  })

  it('Shift+滚轮双向生效：下滑 currentTime 前进', () => {
    const anim = stubTickerAnimation(1000)
    try {
      mockTicker('ok', [{ currency: 'USD', rate: 7.16, yearMonth: '2026-08', changePct: null }])
      mockBrief({ gmv: 12345, orders: 42, pending: 3 })
      render(<TerminalFooter />)
      expect(wheelOnViewport({ deltaY: 100, shiftKey: true })).toBe(true)
      expect(anim.currentTime).toBeGreaterThan(1000)
    } finally {
      removeTickerAnimationStub()
    }
  })
})
