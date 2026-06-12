export const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

export type CountryValue = (typeof COUNTRY_OPTIONS)[number]['value']

/**
 * 启用 VAT 列的国家集合（与后端 `VAT_INCLUSIVE_COUNTRIES = {"DE","UK"}` 对齐）。
 * 用于在月度财务分析表格上条件渲染 VAT 列。
 */
export const VAT_COUNTRIES: ReadonlySet<CountryValue> = new Set<CountryValue>([
  'DE',
  'UK',
])
