// jsPDF 渲染：将 InvoiceForm 画到 A4 文档
// 区块顺序：标题 → Seller + Bill To + 标识卡 → 订单表 → Shipping → 汇总 → 页脚
// 全部 mm 单位；A4 = 210×297mm；边距 15mm。

import { jsPDF } from "jspdf"
import { computeInvoiceTotal, splitVat, summarizeByRate } from "./vat-calc"
import { CURRENCY_OPTIONS, type InvoiceForm, type InvoiceSellerEntry, type SummaryRow } from "../types"

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

  // 鲁棒性：列宽不能超过 A4 可用宽度
  const totalWidth = acc - M
  const maxWidth = PAGE_W - 2 * M
  if (totalWidth > maxWidth) {
    // eslint-disable-next-line no-console
    console.warn(
      `drawTable: 列宽总和 ${totalWidth}mm 超过可用 ${maxWidth}mm，可能溢出页面。`,
    )
  }

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
  rows.forEach((row, rowIdx) => {
    let rowH = 5
    // 检查换行：description 列（通常是第 0 列）可能换行
    const firstColText = row[0] ?? ""
    const firstColLines = doc.splitTextToSize(firstColText, columns[0]!.width - 2)
    const lineCount = Math.max(1, firstColLines.length)
    rowH = Math.max(rowH, lineCount * 4.5)

    // zebra（用 rowIdx 而非 rows.indexOf(row) 避免 O(n²)）
    if (rowIdx % 2 === 1) {
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
  })
  return y
}

/** 顶部 Seller + 标题（标题右上） */
function drawHeader(doc: jsPDF, seller: InvoiceSellerEntry, form: InvoiceForm): number {
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
  seller: InvoiceSellerEntry,
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
    ["Invoice #", form.order_id],
    ["Order ID", form.order_id],
    ["Invoice Date", form.invoice_date],
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

/** 订单明细表（自动换页支持） */
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

  // 拆行：行级 ship 与 item 分开渲染，便于换页判断
  const itemRows: string[][] = []
  for (const it of form.line_items) {
    const sub = splitVat(it.unit_price_incl_vat * it.qty, it.vat_rate)
    const unitExcl = sub.excl / it.qty
    const unitIncl = it.unit_price_incl_vat
    let desc = it.description || "—"
    if (it.asin) desc += `\nASIN: ${it.asin}`
    itemRows.push([
      desc,
      String(it.qty),
      fmtMoney(unitExcl, sym),
      fmtPct(it.vat_rate),
      fmtMoney(unitIncl, sym),
      fmtMoney(sub.incl, sym),
    ])
  }

  const shippingRow: string[] | null =
    form.line_items.length > 0 && form.shipping_incl_vat > 0
      ? (() => {
          const shipRate = form.line_items[0]!.vat_rate
          const ship = splitVat(form.shipping_incl_vat, shipRate)
          return [
            "Shipping Charges",
            "—",
            fmtMoney(ship.excl, sym),
            fmtPct(shipRate),
            fmtMoney(form.shipping_incl_vat, sym),
            fmtMoney(form.shipping_incl_vat, sym),
          ]
        })()
      : null

  y = drawTable(doc, y, columns, itemRows)
  if (shippingRow) y = drawTable(doc, y, columns, [shippingRow])
  return y + 4
}

/** 检查 y 是否在安全打印区，否则换页；返回调整后的 y */
function ensureRoom(
  doc: jsPDF,
  y: number,
  minRoom = 30,
  onNewPage?: () => void,
): { y: number; addedPage: boolean } {
  if (y + minRoom <= PAGE_H - M) return { y, addedPage: false }
  doc.addPage()
  if (onNewPage) onNewPage()
  return { y: M, addedPage: true }
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

/** 页脚（显示当前页码与总页数） */
function drawFooter(doc: jsPDF, seller: InvoiceSellerEntry): void {
  const y = PAGE_H - M
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  const lines: string[] = []
  if (seller.company_name) lines.push(`VAT declared by ${seller.company_name}`)
  if (seller.vat_id) lines.push(`VAT #: ${seller.vat_id}`)
  doc.text(lines.join(" · "), M, y - 6)
  const pageInfo = `Page ${doc.getCurrentPageInfo().pageNumber}`
  doc.text(pageInfo, PAGE_W - M, y, { align: "right" })
  doc.setTextColor(0, 0, 0)
}

/** 主入口（支持多页：明细很多时自动 addPage） */
export function drawInvoice(seller: InvoiceSellerEntry, form: InvoiceForm): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const rows = summarizeByRate(form)

  let y = M
  y = drawHeader(doc, seller, form)
  y = drawBillToAndMeta(doc, form, seller, y + 4)
  y = drawOrderTable(doc, form, y + 2)

  // 汇总与页脚若放不下就换页
  const { y: y2 } = ensureRoom(doc, y, 60)
  y = y2
  y = drawSummary(doc, form, rows, y)
  drawFooter(doc, seller)

  // 用总页数重写每页的 "Page X of N"
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(120, 120, 120)
    doc.text(`Page ${p} of ${totalPages}`, PAGE_W - M, PAGE_H - M, { align: "right" })
    doc.setTextColor(0, 0, 0)
  }

  return doc
}

/** 下载发票 PDF */
export function downloadInvoice(seller: InvoiceSellerEntry, form: InvoiceForm): void {
  const doc = drawInvoice(seller, form)
  const filename = `VAT_${form.order_id || "invoice"}_${form.currency}_${form.invoice_date || "draft"}.pdf`
  doc.save(filename)
}
