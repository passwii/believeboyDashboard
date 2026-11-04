import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  listAllInvoices: vi.fn(),
  voidInvoice: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mocks.notify }),
}))
vi.mock('../lib/invoice-api', () => ({
  fetchProjectsManage: vi.fn().mockResolvedValue([]),
}))
vi.mock('../lib/vat-history-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vat-history-api')>()
  return {
    ...actual,
    listInvoices: mocks.listInvoices,
    listAllInvoices: mocks.listAllInvoices,
    voidInvoice: mocks.voidInvoice,
  }
})
vi.mock('./invoice-detail-dialog', () => ({
  InvoiceDetailDialog: () => null,
}))

import { VatInvoiceHistoryPanel } from './vat-invoice-history-panel'

const row = {
  id: 11,
  invoice_no: 'INV-11',
  project_id: 1,
  project_name: '项目甲',
  currency: 'EUR',
  order_id: 'O-11',
  buyer_name: '买方',
  invoice_date: '2026-11-01',
  subtotal_excl: '100.00',
  total_vat: '19.00',
  total_incl: '119.00',
  status: 'issued' as const,
  has_pdf: true,
  created_at: '',
  updated_at: '',
}

describe('VatInvoiceHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listInvoices.mockResolvedValue([row])
    mocks.listAllInvoices.mockResolvedValue([row])
    mocks.voidInvoice.mockResolvedValue({})
  })

  it('does not void an invoice when the reason prompt is cancelled', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    render(<VatInvoiceHistoryPanel />)

    await user.click(await screen.findByRole('button', { name: '作废' }))

    expect(mocks.voidInvoice).not.toHaveBeenCalled()
  })

  it('distinguishes a load failure from a valid empty result', async () => {
    mocks.listInvoices.mockRejectedValueOnce(new Error('网络不可用'))
    render(<VatInvoiceHistoryPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用')
    expect(screen.queryByText('没有匹配的发票。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('exports all filtered pages instead of only the visible rows', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    })
    render(<VatInvoiceHistoryPanel />)
    await screen.findByText('INV-11')

    await user.click(screen.getByRole('button', { name: '导出 CSV' }))

    await waitFor(() => expect(mocks.listAllInvoices).toHaveBeenCalledTimes(1))
    expect(mocks.listAllInvoices).toHaveBeenCalledWith({
      project_id: undefined,
      status: undefined,
      q: undefined,
    })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
  })
})
