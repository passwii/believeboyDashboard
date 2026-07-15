import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createInvoiceDraft,
  issueInvoice,
  fetchInvoiceDetail,
} from './vat-invoice-api'

describe('vat-invoice-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('createInvoiceDraft POSTs to /vat-invoices with status draft', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }))
    await createInvoiceDraft({
      project_id: 1,
      seller_entity_id: null,
      currency: 'EUR',
      order_id: 'O1',
      invoice_date: '2026-07-15',
      buyer: {
        name: 'B',
        address_line: '',
        postal_code: '',
        city: '',
        country: 'DE',
      },
      shipping_incl_vat: 0,
      lines: [
        {
          description: 'A',
          asin: '',
          qty: 1,
          unit_price_incl_vat: 10,
          vat_rate: 19,
        },
      ],
    })
    const call = spy.mock.calls[0]
    expect(call[0]).toContain('/api/backend/api/v1/vat-invoices')
    expect(call[1]?.method).toBe('POST')
    const body = JSON.parse(call[1]!.body as string)
    expect(body.status).toBe('draft')
  })

  it('issueInvoice POSTs base64 PDF JSON to /vat-invoices/:id/pdf', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await issueInvoice(7, 'AQID', 'invoice-7.pdf')
    const call = spy.mock.calls[0]
    expect(call[0]).toContain('/vat-invoices/7/pdf')
    expect(call[1]?.method).toBe('POST')
    const body = JSON.parse(call[1]!.body as string)
    expect(body.pdf_base64).toBe('AQID')
    expect(body.filename).toBe('invoice-7.pdf')
  })

  it('fetchInvoiceDetail hits GET /vat-invoices/:id', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await fetchInvoiceDetail(9)
    expect(spy.mock.calls[0][0]).toContain('/vat-invoices/9')
  })
})
