import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { InvoiceHistoryTable } from './invoice-history-table'
import type { VatInvoiceListItem } from '../../lib/vat-history-api'

const baseRow: VatInvoiceListItem = {
  id: 1,
  invoice_no: 'INV-DE999-2026-000001',
  project_id: 7,
  project_name: '弥森',
  currency: 'EUR',
  order_id: 'O1',
  buyer_name: 'Buyer',
  invoice_date: '2026-07-15',
  subtotal_excl: '200.00',
  total_vat: '48.00',
  total_incl: '248.00',
  status: 'issued',
  has_pdf: true,
  created_at: '2026-07-15T00:00:00',
  updated_at: '2026-07-15T00:00:00',
}

describe('InvoiceHistoryTable', () => {
  it('renders rows and fires row actions', () => {
    const onSelect = vi.fn()
    const onDownload = vi.fn()
    const onVoid = vi.fn()
    render(
      <InvoiceHistoryTable
        rows={[baseRow]}
        onSelect={onSelect}
        onDownload={onDownload}
        onVoid={onVoid}
      />,
    )
    expect(screen.getByText('INV-DE999-2026-000001')).toBeInTheDocument()
    expect(screen.getByText('已签发')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('详情'))
    expect(onSelect).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTitle('下载 PDF'))
    expect(onDownload).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTitle('作废'))
    expect(onVoid).toHaveBeenCalledWith(1)
  })

  it('shows empty state', () => {
    render(
      <InvoiceHistoryTable rows={[]} onSelect={() => {}} onDownload={() => {}} onVoid={() => {}} />,
    )
    expect(screen.getByText('没有匹配的发票。')).toBeInTheDocument()
  })

  it('voided rows disable void action', () => {
    const onVoid = vi.fn()
    render(
      <InvoiceHistoryTable
        rows={[{ ...baseRow, status: 'voided', has_pdf: false }]}
        onSelect={() => {}}
        onDownload={() => {}}
        onVoid={onVoid}
      />,
    )
    const voidBtn = screen.getByTitle('作废') as HTMLButtonElement
    expect(voidBtn.disabled).toBe(true)
    const downloadBtn = screen.getByTitle('下载 PDF') as HTMLButtonElement
    expect(downloadBtn.disabled).toBe(true)
  })
})
