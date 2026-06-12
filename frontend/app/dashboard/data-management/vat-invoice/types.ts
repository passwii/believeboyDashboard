// VAT 发票 — 共享类型定义
// 关键约束：所有金额以"含税价"为单一事实源，反算不含税价 + VAT。

export type Currency = "EUR" | "GBP" | "PLN" | "CZK" | "USD"

export const CURRENCY_OPTIONS: ReadonlyArray<{ value: Currency; label: string; symbol: string }> = [
  { value: "EUR", label: "EUR - 欧元", symbol: "€" },
  { value: "GBP", label: "GBP - 英镑", symbol: "£" },
  { value: "PLN", label: "PLN - 波兰兹罗提", symbol: "zł" },
  { value: "CZK", label: "CZK - 捷克克朗", symbol: "Kč" },
  { value: "USD", label: "USD - 美元", symbol: "$" },
] as const

// 欧洲常见 VAT 率（百分比）。允许 0 表示免税。
export const VAT_RATE_OPTIONS: ReadonlyArray<number> = [0, 5, 7, 10, 19, 20, 23, 25] as const

/** 单个国家的 Seller 条目（VAT 主体）。按 country 做列表内唯一性约束 */
export interface InvoiceSellerEntry {
  country: string
  company_name: string
  vat_id: string
  address_line: string
  postal_code: string
  city: string
}

/** 商品明细行 */
export interface InvoiceLineItem {
  description: string
  asin: string
  qty: number
  unit_price_incl_vat: number
  vat_rate: number
}

/** 买方信息 */
export interface InvoiceBuyer {
  name: string
  address_line: string
  postal_code: string
  city: string
  country: string
}

/** 完整发票表单（前端 state，不持久化） */
export interface InvoiceForm {
  /** 选中的店铺 ID；null = 未选 */
  project_id: number | null
  currency: Currency
  order_id: string
  invoice_date: string
  buyer: InvoiceBuyer
  line_items: InvoiceLineItem[]
  shipping_incl_vat: number
}

/** VAT 拆分结果 */
export interface VatSplit {
  excl: number
  vat: number
  incl: number
}

/** 按 VAT 率分桶的汇总行 */
export interface SummaryRow {
  rate: number
  itemExcl: number
  itemVat: number
  shippingExcl: number
  shippingVat: number
  total: number
}

/** 店铺下拉项（来自 GET /projects/manage，类型 ProjectItem） */
export interface ProjectOption {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  has_context: boolean
  is_active: boolean
  project_tier: string | null
}

/** 店铺 context */
export interface ProjectContext {
  project_id: number
  project_name: string
  project_context: {
    invoice_sellers?: InvoiceSellerEntry[]
    /** 旧单数字段，仅供惰性迁移读取（invoice-api.ts migrateSellersIfNeeded） */
    invoice_seller?: InvoiceSellerEntry
  } | null
  sku_context: unknown
}
