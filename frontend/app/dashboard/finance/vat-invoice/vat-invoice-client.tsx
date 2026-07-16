'use client'

// 欧洲 VAT 发票生成器 — 主客户端协调器
// 流程：选店铺 → 加载 Seller 列表 → 选国家 → 录入订单/明细/运费 → 实时汇总 → 预览 → 下载 PDF

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileText, Save } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SellerCard } from './components/seller-card'
import { InvoiceFormSection } from './components/invoice-form'
import { LineItemsEditor } from './components/line-items-editor'
import { InvoiceSummary } from './components/invoice-summary'
import { InvoicePreviewDialog } from './components/invoice-preview-dialog'
import { VatInvoiceHistoryPanel } from './components/vat-invoice-history-panel'
import { computeInvoiceTotal } from './lib/vat-calc'
import { createInvoiceDraft } from './lib/vat-invoice-api'
import { CURRENCY_OPTIONS, type InvoiceForm, type InvoiceSellerEntry, type VatEntity } from './types'

const emptyBuyer = {
  name: '',
  address_line: '',
  postal_code: '',
  city: '',
  country: '',
}

const initialForm: InvoiceForm = {
  project_id: null, // null = 未选
  currency: 'EUR',
  order_id: '',
  invoice_date: '',
  buyer: { ...emptyBuyer },
  line_items: [],
  shipping_incl_vat: 0,
}

const emptySellerEntry: InvoiceSellerEntry = {
  company_name: '',
  vat_id: '',
  address_line: '',
  postal_code: '',
  city: '',
  country: '',
}

function getSymbol(currency: InvoiceForm['currency']): string {
  return CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol ?? currency
}

function toInvoiceSellerEntry(e: VatEntity): InvoiceSellerEntry {
  return {
    country: e.country,
    company_name: e.company_name,
    vat_id: e.vat_id,
    address_line: e.address_line,
    postal_code: e.postal_code,
    city: e.city,
  }
}

export default function VatInvoiceClient() {
  const searchParams = useSearchParams()
  const [form, setForm] = useState<InvoiceForm>(initialForm)
  const [sellers, setSellers] = useState<VatEntity[]>([])
  const [selectedCountry, setSelectedCountry] = useState<string>('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const { notify } = useNotifications()

  const defaultTab = searchParams.get('tab') === 'history' ? 'history' : 'create'

  const symbol = getSymbol(form.currency)

  // 当前选中 Seller
  const seller = useMemo(
    () => sellers.find((s) => s.country === selectedCountry) ?? null,
    [sellers, selectedCountry]
  )
  // 选中 Seller 对应的 vat_entity.id（用于签发时填 seller_entity_id）
  const sellerEntityId = seller?.id ?? null

  async function saveDraft() {
    if (form.project_id == null) return
    setSavingDraft(true)
    try {
      const rec = await createInvoiceDraft({
        project_id: form.project_id,
        seller_entity_id: sellerEntityId,
        currency: form.currency,
        order_id: form.order_id,
        invoice_date: form.invoice_date,
        buyer: form.buyer,
        shipping_incl_vat: form.shipping_incl_vat,
        lines: form.line_items.map((li) => ({
          description: li.description,
          asin: li.asin,
          qty: li.qty,
          unit_price_incl_vat: li.unit_price_incl_vat,
          vat_rate: li.vat_rate,
        })),
      })
      notify({ type: 'success', title: '草稿已保存', message: rec.invoice_no })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: normalizeErrorMessage(err) })
    } finally {
      setSavingDraft(false)
    }
  }

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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">VAT 发票</h1>
        <p className="text-sm text-muted-foreground">
          为欧洲订单生成 VAT 发票，并查看已签发/草稿/作废的发票历史。
        </p>
      </div>

      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList>
          <TabsTrigger value="create">新建发票</TabsTrigger>
          <TabsTrigger value="history">发票历史</TabsTrigger>
        </TabsList>

        <TabsContent value="create" className="mt-4">
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
                <Button
                  className="w-full"
                  variant="secondary"
                  size="lg"
                  disabled={!canPreview || savingDraft}
                  onClick={saveDraft}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {savingDraft ? '保存中…' : '保存草稿'}
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
            seller={seller ? toInvoiceSellerEntry(seller) : emptySellerEntry}
            form={form}
            sellerEntityId={sellerEntityId}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <VatInvoiceHistoryPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
