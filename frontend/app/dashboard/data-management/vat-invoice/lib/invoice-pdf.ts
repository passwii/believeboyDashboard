// jsPDF 渲染：将 InvoiceForm 画到 A4 文档
// 区块顺序：标题 → Seller + Bill To + 标识卡 → 订单表 → Shipping → 汇总 → 页脚
// 全部 mm 单位；A4 = 210×297mm；边距 15mm。

import { jsPDF } from "jspdf"
import { computeInvoiceTotal, splitVat, summarizeByRate } from "./vat-calc"
import { CURRENCY_OPTIONS, type InvoiceForm, type InvoiceSeller, type SummaryRow } from "../types"

const PAGE_W = 210
const PAGE_H = 297
const M = 15 // margin mm

function getSymbol(currency: InvoiceForm["currency"]): string {
  return CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol ?? currency
}

const fmtMoney = (n: number, sym: string) => `${sym}${n.toFixed(2)}`
const fmtPct = (n: number) => `${n}%`

/** 写多行文本，自动换行，返回下一行 y 坐标 */
function writeWrappedText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight = 5,
): number {
  if (!text) return y
  const lines = doc.splitTextToSize(text, maxWidth)
  doc.text(lines, x, y)
  return y + lines.length * lineHeight
}

/** 画一个简单的 table header + rows；返回下一行 y 坐标 */
function drawTable(
  doc: jsPDF,
  startY: number,
  columns: Array<{ header: string; width: number; align?: "left" | "right" }>,
  rows: string[][],
): number {
  let y = startY
  const colX: number[] = []
  let acc = M
  columns.forEach((c, i) => {
    colX.push(acc)
    acc += c.width
  })

  // header
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.setFillColor(241, 245, 249)
  doc.rect(M, y - 4, PAGE_W - 2 * M, 6, "F")
  columns.forEach((c, i) => {
    const x = c.align === "right" ? colX[i]! + c.width - 1 : colX[i]! + 1
    doc.text(c.header, x, y, { align: c.align ?? "left" })
  })
  y += 6

  // rows
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  for (const row of rows) {
    let rowH = 5
    // 检查换行：description 列（通常是第 0 列）可能换行
    const firstColText = row[0] ?? ""
    const firstColLines = doc.splitTextToSize(firstColText, columns[0]!.width - 2)
    const lineCount = Math.max(1, firstColLines.length)
    rowH = Math.max(rowH, lineCount * 4.5)

    // zebra
    if (rows.indexOf(row) % 2 === 1) {
      doc.setFillColor(248, 250, 252)
      doc.rect(M, y - 4, PAGE_W - 2 * M, rowH, "F")
    }

    columns.forEach((c, i) => {
      const text = row[i] ?? ""
      const x = c.align === "right" ? colX[i]! + c.width - 1 : colX[i]! + 1
      const lines = doc.splitTextToSize(text, c.width - 2)
      doc.text(lines, x, y, { align: c.align ?? "left" })
    })
    y += rowH
  }
  return y
}

/** 顶部 Seller + 标题（标题右上） */
function drawHeader(doc: jsPDF, seller: InvoiceSeller, form: InvoiceForm): number {
  let y = M + 5

  // Seller 块（左上）
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.text(seller.company_name || "Seller", M, y)
  y += 5
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  if (seller.vat_id) {
    doc.text(`VAT: ${seller.vat_id}`, M, y)
    y += 4
  }
  if (seller.address_line) {
    y = writeWrappedText(doc, seller.address_line, M, y, 80) + 0
    y += 0
  }
  const cityLine = [seller.postal_code, seller.city, seller.country].filter(Boolean).join(" ")
  if (cityLine) {
    doc.text(cityLine, M, y)
    y += 5
  }

  // 标题（右上）
  doc.setFont("helvetica", "bold")
  doc.setFontSize(22)
  doc.text("Invoice", PAGE_W - M, M + 8, { align: "right" })

  return Math.max(y, M + 25)
}

/** Bill To + 标识卡 */
function drawBillToAndMeta(
  doc: jsPDF,
  form: InvoiceForm,
  seller: InvoiceSeller,
  y: number,
): number {
  const colLeft = M
  const colRight = PAGE_W - M - 60
  const startY = y

  // Bill To (左)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.text("Bill To", colLeft, y)
  y += 4
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(form.buyer.name || "—", colLeft, y)
  y += 4
  y = writeWrappedText(doc, form.buyer.address_line, colLeft, y, 80) + 0
  y += 0
  const buyerCity = [form.buyer.postal_code, form.buyer.city, form.buyer.country]
    .filter(Boolean)
    .join(" ")
  if (buyerCity) {
    doc.text(buyerCity, colLeft, y)
    y += 4
  }
  const leftEnd = y

  // 标识卡 (右)
  let ry = startY
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.text("Invoice Details", colRight, ry)
  ry += 4
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  const sym = getSymbol(form.currency)
  const total = computeInvoiceTotal(form)
  const meta: Array<[string, string]> = [
    ["Invoice #", form.bill_id],
    ["Order ID", form.order_id],
    ["Invoice Date", form.invoice_date],
    ["Delivery Date", form.delivery_date],
    ["VAT declared by", seller.company_name || "—"],
    ["VAT #", seller.vat_id || "—"],
    ["Total payable", fmtMoney(total, sym)],
  ]
  for (const [k, v] of meta) {
    doc.setFont("helvetica", "bold")
    doc.text(`${k}:`, colRight, ry)
    doc.setFont("helvetica", "normal")
    doc.text(v, colRight + 35, ry)
    ry += 4
  }

  return Math.max(leftEnd, ry) + 4
}

/** 订单明细表 */
function drawOrderTable(doc: jsPDF, form: InvoiceForm, y: number): number {
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.text("Order Details", M, y)
  y += 6

  const sym = getSymbol(form.currency)
  const columns = [
    { header: "Description", width: 70 },
    { header: "Qty", width: 12, align: "right" as const },
    { header: "Unit (excl.)", width: 24, align: "right" as const },
    { header: "VAT", width: 14, align: "right" as const },
    { header: "Unit (incl.)", width: 24, align: "right" as const },
    { header: "Subtotal (incl.)", width: 26, align: "right" as const },
  ]

  const rows: string[][] = []
  for (const it of form.line_items) {
    const sub = splitVat(it.unit_price_incl_vat * it.qty, it.vat_rate)
    const unitExcl = sub.excl / it.qty
    const unitIncl = it.unit_price_incl_vat
    let desc = it.description || "—"
    if (it.asin) desc += `\nASIN: ${it.asin}`
    rows.push([
      desc,
      String(it.qty),
      fmtMoney(unitExcl, sym),
      fmtPct(it.vat_rate),
      fmtMoney(unitIncl, sym),
      fmtMoney(sub.incl, sym),
    ])
  }

  // shipping row
  if (form.line_items.length > 0 && form.shipping_incl_vat > 0) {
    const shipRate = form.line_items[0]!.vat_rate
    const ship = splitVat(form.shipping_incl_vat, shipRate)
    rows.push([
      "Shipping Charges",
      "—",
      fmtMoney(ship.excl, sym),
      fmtPct(shipRate),
      fmtMoney(form.shipping_incl_vat, sym),
      fmtMoney(form.shipping_incl_vat, sym),
    ])
  }

  y = drawTable(doc, y, columns, rows)
  return y + 4
}

/** 底部汇总：Invoice total + 按 VAT 率分桶 */
function drawSummary(doc: jsPDF, form: InvoiceForm, rows: SummaryRow[], y: number): number {
  const sym = getSymbol(form.currency)
  const total = computeInvoiceTotal(form)

  // Invoice total
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("Invoice Total", PAGE_W - M, y, { align: "right" })
  doc.text(fmtMoney(total, sym), PAGE_W - M, y + 6, { align: "right" })
  y += 14

  // 按 VAT 率分桶表
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  doc.text("VAT breakdown by rate", M, y)
  y += 5

  const columns = [
    { header: "VAT rate", width: 25 },
    { header: "Item subtotal (excl.)", width: 40, align: "right" as const },
    { header: "Item VAT", width: 30, align: "right" as const },
    { header: "Shipping (excl.)", width: 30, align: "right" as const },
    { header: "Shipping VAT", width: 30, align: "right" as const },
    { header: "Total", width: 25, align: "right" as const },
  ]
  const dataRows = rows.map((r) => [
    fmtPct(r.rate),
    fmtMoney(r.itemExcl, sym),
    fmtMoney(r.itemVat, sym),
    fmtMoney(r.shippingExcl, sym),
    fmtMoney(r.shippingVat, sym),
    fmtMoney(r.total, sym),
  ])
  y = drawTable(doc, y, columns, dataRows)
  return y
}

/** 页脚 */
function drawFooter(doc: jsPDF, seller: InvoiceSeller): void {
  const y = PAGE_H - M
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  const lines: string[] = []
  if (seller.company_name) lines.push(`VAT declared by ${seller.company_name}`)
  if (seller.vat_id) lines.push(`VAT #: ${seller.vat_id}`)
  doc.text(lines.join(" · "), M, y - 6)
  doc.text("Page 1 of 1", PAGE_W - M, y, { align: "right" })
  doc.setTextColor(0, 0, 0)
}

/** 主入口 */
export function drawInvoice(seller: InvoiceSeller, form: InvoiceForm): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const rows = summarizeByRate(form)

  let y = M
  y = drawHeader(doc, seller, form)
  y = drawBillToAndMeta(doc, form, seller, y + 4)
  y = drawOrderTable(doc, form, y + 2)
  if (y > PAGE_H - 80) y = PAGE_H - 80
  y = drawSummary(doc, form, rows, y)
  drawFooter(doc, seller)

  return doc
}

/** 下载发票 PDF */
export function downloadInvoice(seller: InvoiceSeller, form: InvoiceForm): void {
  const doc = drawInvoice(seller, form)
  const filename = `VAT_${form.order_id || "invoice"}_${form.currency}_${form.invoice_date || "draft"}.pdf`
  doc.save(filename)
}
