import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

// ── mocks ────────────────────────────────────────────────────────────────────

const navigationMock = vi.hoisted(() => ({ search: '' }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigationMock.search),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('./lib/vat-invoice-api', () => ({
  createInvoiceDraft: vi.fn(),
}))

vi.mock('./components/seller-card', () => ({
  SellerCard: () => <div data-testid="seller-card" />,
}))
vi.mock('./components/invoice-form', () => ({
  InvoiceFormSection: () => <div data-testid="invoice-form" />,
}))
vi.mock('./components/line-items-editor', () => ({
  LineItemsEditor: () => <div data-testid="line-items-editor" />,
}))
vi.mock('./components/invoice-preview-dialog', () => ({
  InvoicePreviewDialog: () => null,
}))
vi.mock('./components/vat-invoice-history-panel', () => ({
  VatInvoiceHistoryPanel: () => <div data-testid="history-panel" />,
}))

import VatInvoiceClient from './vat-invoice-client'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigationMock.search = ''
})

describe('VatInvoiceClient Warm Ledger 渲染契约', () => {
  it('两个 Tab 使用 Warm 本地样式，且不恢复页面级标题胶囊', () => {
    const { container } = render(<VatInvoiceClient />)
    const page = container.firstElementChild
    const tabList = screen.getByRole('tablist')

    expect(page).toHaveAttribute('data-warm-vat-invoice', 'true')
    expect(tabList).toHaveAttribute('data-warm-tablist', 'true')
    expect(screen.getByText('新建发票')).toBeInTheDocument()
    expect(screen.getByText('发票历史')).toBeInTheDocument()

    for (const label of ['新建发票', '发票历史']) {
      const trigger = screen.getByRole('tab', { name: label })
      expect(trigger.className).not.toContain('rounded-none')
      expect(trigger.className).not.toContain('term-')
    }

    expect(screen.getByTestId('seller-card')).toBeInTheDocument()
    expect(screen.getByTestId('invoice-form')).toBeInTheDocument()
    expect(screen.getByTestId('line-items-editor')).toBeInTheDocument()
    expect(screen.queryByText('VAT 发票')).toBeNull()
  })

  it('默认落在新建发票页签，?tab=history 时直接落在历史页签', () => {
    const { unmount } = render(<VatInvoiceClient />)
    expect(screen.getByTestId('seller-card')).toBeInTheDocument()
    unmount()
    cleanup()

    navigationMock.search = 'tab=history'
    render(<VatInvoiceClient />)
    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('seller-card')).toBeNull()
  })

  it('query-only navigation to ?tab=history activates the history tab', () => {
    const view = render(<VatInvoiceClient />)
    expect(screen.getByTestId('seller-card')).toBeInTheDocument()

    navigationMock.search = 'tab=history'
    view.rerender(<VatInvoiceClient />)

    expect(screen.getByTestId('history-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('seller-card')).toBeNull()
  })
})
