// VAT 发票 API 客户端（生成器 → 后端：建草稿 / 上传 PDF 签发 / 取详情）

import type { VatInvoiceRecord } from '../types'

const BASE = '/api/backend/api/v1'

export interface CreateInvoiceInput {
  project_id: number
  seller_entity_id: number | null
  currency: string
  order_id: string
  invoice_date: string // YYYY-MM-DD
  buyer: {
    name: string
    address_line: string
    postal_code: string
    city: string
    country: string
  }
  shipping_incl_vat: number
  lines: Array<{
    description: string
    asin: string
    qty: number
    unit_price_incl_vat: number
    vat_rate: number
  }>
  status?: 'draft' | 'issued'
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

/** 创建草稿（默认 status=draft；后端也会用 id 回填 invoice_no） */
export async function createInvoiceDraft(
  input: CreateInvoiceInput,
): Promise<VatInvoiceRecord> {
  const res = await fetch(`${BASE}/vat-invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, status: input.status ?? 'draft' }),
  })
  return (await jsonOrThrow(res)) as VatInvoiceRecord
}

/** 上传 PDF 字节（base64 编码）触发签发：draft → issued，PDF 存 R2 */
export async function issueInvoice(
  invoiceId: number,
  pdfBase64: string,
  filename: string,
): Promise<VatInvoiceRecord> {
  const res = await fetch(`${BASE}/vat-invoices/${invoiceId}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_base64: pdfBase64, filename }),
  })
  return (await jsonOrThrow(res)) as VatInvoiceRecord
}

/** 取发票详情（带 lines） */
export async function fetchInvoiceDetail(id: number): Promise<VatInvoiceRecord> {
  const res = await fetch(`${BASE}/vat-invoices/${id}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  return (await jsonOrThrow(res)) as VatInvoiceRecord
}
