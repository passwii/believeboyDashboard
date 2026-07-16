// VAT 发票历史 API 客户端

const BASE = '/api/backend/api/v1'

export interface VatInvoiceListItem {
  id: number
  invoice_no: string
  project_id: number
  project_name: string
  currency: string
  order_id: string
  buyer_name: string
  invoice_date: string
  subtotal_excl: string
  total_vat: string
  total_incl: string
  status: 'draft' | 'issued' | 'voided'
  has_pdf: boolean
  created_at: string
  updated_at: string
}

export interface VatInvoiceDetail {
  id: number
  invoice_no: string
  project_id: number
  seller_entity_id: number | null
  seller_snapshot: Record<string, string>
  buyer: {
    name: string
    address_line: string
    postal_code: string
    city: string
    country: string
  }
  currency: string
  order_id: string
  invoice_date: string
  shipping_incl_vat: string
  subtotal_excl: string
  total_vat: string
  total_incl: string
  summary_by_rate: Array<Record<string, string | number>>
  r2_key: string | null
  r2_url: string | null
  status: 'draft' | 'issued' | 'voided'
  void_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  lines: Array<{
    id: number
    line_no: number
    description: string
    asin: string
    qty: number
    unit_price_incl_vat: string
    vat_rate: string
    line_excl: string
    line_vat: string
    line_incl: string
  }>
}

export interface ListParams {
  project_id?: number
  status?: 'draft' | 'issued' | 'voided'
  q?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

export async function listInvoices(params: ListParams = {}): Promise<VatInvoiceListItem[]> {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') qs.set(k, String(v))
  })
  const res = await fetch(`${BASE}/vat-invoices?${qs.toString()}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  return (await jsonOrThrow(res)) as VatInvoiceListItem[]
}

export async function getInvoiceDetail(id: number): Promise<VatInvoiceDetail> {
  const res = await fetch(`${BASE}/vat-invoices/${id}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  return (await jsonOrThrow(res)) as VatInvoiceDetail
}

export async function voidInvoice(id: number, reason: string): Promise<VatInvoiceDetail> {
  const res = await fetch(`${BASE}/vat-invoices/${id}/void`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  return (await jsonOrThrow(res)) as VatInvoiceDetail
}

export function buildInvoicePdfUrl(id: number): string {
  return `${BASE}/vat-invoices/${id}/pdf`
}

/** 后端 /pdf 端点会 302 到 R2 公共 URL，直接开新标签即可 */
export function downloadInvoicePdf(id: number): void {
  window.open(buildInvoicePdfUrl(id), '_blank')
}

export function exportInvoicesCsv(rows: VatInvoiceListItem[]): string {
  const header = [
    'invoice_no',
    'project_name',
    'buyer_name',
    'currency',
    'invoice_date',
    'total_incl',
    'status',
    'order_id',
    'has_pdf',
  ] as const
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    header.join(','),
    ...rows.map((r) => header.map((h) => escape((r as unknown as Record<string, unknown>)[h])).join(',')),
  ].join('\n')
}
