import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  isWarmLedgerRoute,
  isWarmLedgerStandaloneRoute,
} from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame'

const { fetchProjectOptionsCachedMock } = vi.hoisted(() => ({
  fetchProjectOptionsCachedMock: vi.fn(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchProjectOptionsCached: fetchProjectOptionsCachedMock,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import DigitalDisplayPage from './page'

describe('DigitalDisplayPage exception', () => {
  it('stays outside Warm Ledger and preserves forced dark/fullscreen behavior', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    fetchProjectOptionsCachedMock.mockResolvedValue({ items: [] })

    const { container, unmount } = render(<DigitalDisplayPage />)

    expect(isWarmLedgerRoute('/dashboard/system/digital-display')).toBe(true)
    expect(isWarmLedgerStandaloneRoute('/dashboard/system/digital-display')).toBe(true)
    expect(container.firstElementChild).toHaveAttribute(
      'data-digital-display-exception',
      'true',
    )
    expect(container.firstElementChild).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.firstElementChild).toHaveClass('warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(container.querySelector('.warm-ledger__app-window')).toBeNull()
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
    expect(requestFullscreen).toHaveBeenCalledTimes(1)

    unmount()
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('Escape 与退出全屏按钮继续调用 Fullscreen API', async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    })
    fetchProjectOptionsCachedMock.mockResolvedValue({ items: [] })

    const { unmount } = render(<DigitalDisplayPage />)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalled())
    exitFullscreen.mockClear()

    const button = await screen.findByRole('button', { name: /退出全屏/ })
    fireEvent.click(button)
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalled())

    unmount()
  })

  it('销售趋势使用页面本地 Warm chart，不引用共享 AreaChartCard 默认视觉', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/dashboard/system/digital-display/page.tsx'),
      'utf8'
    )

    expect(source).toContain('WarmTrendChart')
    expect(source).not.toContain('AreaChartCard')
  })
})
