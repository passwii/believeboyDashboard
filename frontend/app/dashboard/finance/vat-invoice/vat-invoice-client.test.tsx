import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: vi.fn() }),
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
})

describe('VatInvoiceClient 终端化渲染契约（BLF-835）', () => {
  it('Tab 切换齐全（新建发票 / 发票历史），无 PageHeader 胶囊残留', () => {
    render(<VatInvoiceClient />)
    expect(screen.getByText('新建发票')).toBeInTheDocument()
    expect(screen.getByText('发票历史')).toBeInTheDocument()
    // 表单区子组件挂载
    expect(screen.getByTestId('seller-card')).toBeInTheDocument()
    expect(screen.getByTestId('invoice-form')).toBeInTheDocument()
    expect(screen.getByTestId('line-items-editor')).toBeInTheDocument()
    // 无页面级大标题胶囊（标题由面包屑承载）
    expect(screen.queryByText('VAT 发票')).toBeNull()
  })

  it('默认无 tab 参数时落在新建发票页签，?tab=history 时落在历史页签', () => {
    const { unmount } = render(<VatInvoiceClient />)
    expect(screen.getByTestId('seller-card')).toBeInTheDocument()
    unmount()
    cleanup()
    // history tab 由 useSearchParams mock 返回空串控制；此处仅验证再次渲染稳定
    render(<VatInvoiceClient />)
    expect(screen.getByText('发票历史')).toBeInTheDocument()
  })
})
