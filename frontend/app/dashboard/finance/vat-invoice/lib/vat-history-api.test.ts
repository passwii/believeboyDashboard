import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listInvoices,
  listAllInvoices,
  voidInvoice,
  downloadInvoicePdf,
  exportInvoicesCsv,
  buildInvoicePdfUrl,
} from './vat-history-api'

describe('vat-history-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('listInvoices builds query string', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }))
    await listInvoices({ project_id: 7, status: 'issued' })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('project_id=7')
    expect(url).toContain('status=issued')
  })

  it('listAllInvoices pages until the backend returns a short page', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: index + 1 }))
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(firstPage), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 501 }]), { status: 200 })
      )

    const rows = await listAllInvoices({ project_id: 7, status: 'issued' })

    expect(rows).toHaveLength(501)
    expect(spy).toHaveBeenCalledTimes(2)
    const secondUrl = new URL(String(spy.mock.calls[1][0]), 'http://localhost')
    expect(secondUrl.searchParams.get('limit')).toBe('500')
    expect(secondUrl.searchParams.get('offset')).toBe('500')
  })

  it('voidInvoice POSTs with reason', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await voidInvoice(11, 'test reason')
    const call = spy.mock.calls[0]
    expect(call[1]?.method).toBe('POST')
    expect(JSON.parse(call[1]!.body as string).reason).toBe('test reason')
  })

  it('downloadInvoicePdf opens /pdf endpoint', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null)
    downloadInvoicePdf(9)
    expect(spy.mock.calls[0][0]).toContain('/vat-invoices/9/pdf')
    expect(spy.mock.calls[0][1]).toBe('_blank')
  })

  it('exportInvoicesCsv builds CSV from rows', () => {
    const rows = [
      {
        id: 1,
        invoice_no: 'INV-1',
        project_name: '弥森',
        buyer_name: 'B',
        currency: 'EUR',
        invoice_date: '2026-07-15',
        subtotal_excl: '100.00',
        total_vat: '19.00',
        total_incl: '119.00',
        status: 'issued' as const,
        has_pdf: true,
        created_at: '',
        updated_at: '',
        order_id: 'O1',
        project_id: 1,
      },
    ]
    const csv = exportInvoicesCsv(rows)
    expect(csv.split('\n')[0]).toContain('invoice_no')
    expect(csv).toContain('INV-1')
    expect(csv).toContain('弥森')
  })

  it('buildInvoicePdfUrl returns /pdf endpoint', () => {
    expect(buildInvoicePdfUrl(42)).toContain('/vat-invoices/42/pdf')
  })
})
