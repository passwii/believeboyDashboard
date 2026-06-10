"use client"

// 欧洲 VAT 发票生成器 — 主客户端协调器
// 流程：选店铺 → 加载 Seller 列表 → 选国家 → 录入订单/明细/运费 → 实时汇总 → 预览 → 下载 PDF

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { FileText } from "lucide-react"
import { SellerCard } from "./components/seller-card"
import { InvoiceFormSection } from "./components/invoice-form"
import { LineItemsEditor } from "./components/line-items-editor"
import { InvoiceSummary } from "./components/invoice-summary"
import { InvoicePreviewDialog } from "./components/invoice-preview-dialog"
import { computeInvoiceTotal } from "./lib/vat-calc"
import { CURRENCY_OPTIONS, type InvoiceForm, type InvoiceSellerEntry } from "./types"

const emptyBuyer = {
  name: "",
  address_line: "",
  postal_code: "",
  city: "",
  country: "",
}

const initialForm: InvoiceForm = {
  project_id: null, // null = 未选
  currency: "EUR",
  order_id: "",
  invoice_date: "",
  buyer: { ...emptyBuyer },
  line_items: [],
  shipping_incl_vat: 0,
}

const emptySellerEntry: InvoiceSellerEntry = {
  company_name: "",
  vat_id: "",
  address_line: "",
  postal_code: "",
  city: "",
  country: "",
}

function getSymbol(currency: InvoiceForm["currency"]): string {
  return CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol ?? currency
}

export default function VatInvoiceClient() {
  const [form, setForm] = useState<InvoiceForm>(initialForm)
  const [sellers, setSellers] = useState<InvoiceSellerEntry[]>([])
  const [selectedCountry, setSelectedCountry] = useState<string>("")
  const [previewOpen, setPreviewOpen] = useState(false)

  const symbol = getSymbol(form.currency)

  // 当前选中 Seller
  const seller = useMemo(
    () => sellers.find((s) => s.country === selectedCountry) ?? null,
    [sellers, selectedCountry],
  )

  // 校验：发票可预览的最小条件
  const canPreview = useMemo(() => {
    if (form.project_id == null) return false
    if (!form.order_id.trim()) return false
    if (!form.invoice_date) return false
    if (!form.buyer.name.trim() || !form.buyer.address_line.trim()) return false
    if (!seller?.company_name.trim()) return false
    if (form.line_items.length === 0) return false
    if (form.line_items.some((it) => !it.description.trim())) return false
    return true
  }, [form, seller])

  const invoiceTotal = useMemo(() => computeInvoiceTotal(form), [form])

  return (
    <div className="space-y-4 px-1 py-1">
      {/* 页面 Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          VAT 发票生成器
        </h1>
        <p className="text-sm text-muted-foreground">
          为欧洲订单快速生成 VAT 发票：选择店铺自动预填 Seller 信息，录入订单后实时计算 VAT 并导出 PDF。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 左：表单（占 2/3） */}
        <div className="space-y-4 lg:col-span-2">
          <SellerCard
            selectedProjectId={form.project_id}
            sellers={sellers}
            selectedCountry={selectedCountry}
            onSellersChange={setSellers}
            onCountryChange={setSelectedCountry}
            onSelectProject={(id) => setForm({ ...form, project_id: id })}
          />

          <InvoiceFormSection form={form} onChange={setForm} />
          <LineItemsEditor form={form} currencySymbol={symbol} onChange={setForm} />
        </div>

        {/* 右：实时汇总 + 预览按钮 */}
        <div className="space-y-4">
          <div className="sticky top-4 space-y-4">
            <InvoiceSummary form={form} />
            <Button
              className="w-full"
              size="lg"
              disabled={!canPreview}
              onClick={() => setPreviewOpen(true)}
            >
              <FileText className="mr-2 h-4 w-4" />
              预览并导出 PDF
            </Button>
            {!canPreview && (
              <p className="text-xs text-muted-foreground">
                请先选择店铺、选择国家、填写订单、买方和至少一行商品。
              </p>
            )}
            {canPreview && (
              <p className="text-xs text-muted-foreground">
                预计发票总额：{symbol}
                {invoiceTotal.toFixed(2)}
              </p>
            )}
          </div>
        </div>
      </div>

      <InvoicePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        seller={seller ?? emptySellerEntry}
        form={form}
      />
    </div>
  )
}
