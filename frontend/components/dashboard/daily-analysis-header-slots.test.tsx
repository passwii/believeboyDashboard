import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DailyAnalysisHeaderSlots } from './daily-analysis-header-slots'
import {
  HeaderSlotMount,
  MobileStripMount,
  PrimaryFilterSlotMount,
  SecondaryHeaderSlotMount,
  TerminalHeaderSlotProvider,
} from '@/components/terminal/terminal-header-slot'

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: isMobileMock }))

function SlotsHarness({ isMobile }: { isMobile: boolean }) {
  return (
    <TerminalHeaderSlotProvider>
      <header>
        <HeaderSlotMount />
        <PrimaryFilterSlotMount />
        <SecondaryHeaderSlotMount />
      </header>
      <main>
        <MobileStripMount />
        <DailyAnalysisHeaderSlots
          isMobile={isMobile}
          primaryControls={<span data-testid="primary-controls">项目与日期</span>}
          secondaryControls={<span data-testid="secondary-controls">站点与 SKU</span>}
          mobileControls={<span data-testid="mobile-controls">项目、日期、站点与 SKU</span>}
        />
      </main>
    </TerminalHeaderSlotProvider>
  )
}

beforeEach(() => {
  isMobileMock.mockReturnValue(false)
})

afterEach(() => {
  cleanup()
})

describe('DailyAnalysisHeaderSlots', () => {
  it('桌面端将首层和次级控件分发到各自头部插槽', async () => {
    render(<SlotsHarness isMobile={false} />)

    await waitFor(() => {
      expect(screen.getByTestId('terminal-primary-filter-slot')).toContainElement(
        screen.getByTestId('primary-controls')
      )
      expect(screen.getByTestId('terminal-secondary-header-slot')).toContainElement(
        screen.getByTestId('secondary-controls')
      )
    })
    expect(screen.getByTestId('terminal-header-slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('terminal-mobile-strip')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('mobile-controls')).not.toBeInTheDocument()
  })

  it('daily-analysis 的项目/日期常驻首层，站点/SKU 放在默认收起的次级行', async () => {
    render(<SlotsHarness isMobile={false} />)

    await waitFor(() => {
      expect(screen.getByTestId('terminal-primary-filter-slot')).toContainElement(
        screen.getByTestId('primary-controls')
      )
      expect(screen.getByTestId('terminal-secondary-header-slot')).toContainElement(
        screen.getByTestId('secondary-controls')
      )
    })

    const primaryRow = screen.getByTestId('terminal-primary-filter-slot')
    const secondaryRow = screen.getByTestId('terminal-secondary-header-slot')
    expect(primaryRow).toContainElement(screen.getByTestId('primary-controls'))
    expect(primaryRow).not.toContainElement(screen.getByTestId('secondary-controls'))
    expect(screen.getByTestId('primary-controls')).toHaveTextContent('项目与日期')
    expect(screen.getByTestId('secondary-controls')).toHaveTextContent('站点与 SKU')
  })

  it('移动端筛选条保留项目、日期、站点和 SKU，并且不占用桌面两层插槽', async () => {
    isMobileMock.mockReturnValue(true)
    render(<SlotsHarness isMobile />)

    await waitFor(() => {
      expect(screen.getByTestId('terminal-mobile-strip')).toContainElement(
        screen.getByTestId('mobile-controls')
      )
    })
    expect(screen.getByTestId('mobile-controls')).toHaveTextContent('项目、日期、站点与 SKU')
    expect(screen.getByTestId('terminal-primary-filter-slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('terminal-secondary-header-slot')).toBeEmptyDOMElement()
  })

  it('移动端只挂载现有移动筛选条，不占用桌面头部插槽', async () => {
    isMobileMock.mockReturnValue(true)
    render(<SlotsHarness isMobile />)

    await waitFor(() => {
      expect(screen.getByTestId('terminal-mobile-strip')).toContainElement(
        screen.getByTestId('mobile-controls')
      )
    })
    expect(screen.getByTestId('terminal-header-slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('terminal-primary-filter-slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('terminal-secondary-header-slot')).toBeEmptyDOMElement()
    expect(screen.queryByTestId('primary-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('secondary-controls')).not.toBeInTheDocument()
  })
})
