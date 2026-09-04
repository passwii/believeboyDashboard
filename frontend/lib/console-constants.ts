export const COUNTRY_OPTIONS = [
  { value: 'ALL', label: '全部站点' },
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

export type CountryValue = (typeof COUNTRY_OPTIONS)[number]['value']

/**
 * 启用 VAT 列的国家集合（与后端 `VAT_INCLUSIVE_COUNTRIES = {"DE","UK"}` 对齐）。
 * 用于在月度财务分析表格上条件渲染 VAT 列。
 */
export const VAT_COUNTRIES: ReadonlySet<CountryValue> = new Set<CountryValue>(['DE', 'UK'])

/**
 * 后端实际支持的国家站点集合（与后端 COUNTRY_NORMALIZE_MAP / supported_countries 对齐）。
 * 用于筛掉聚合占位值（如 "ALL"），避免向后端发起非法 country 参数。
 */
export const REAL_COUNTRY_VALUES: ReadonlySet<CountryValue> = new Set<CountryValue>([
  'US',
  'DE',
  'UK',
])
