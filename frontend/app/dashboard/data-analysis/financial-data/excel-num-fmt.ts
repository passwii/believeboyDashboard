// Pure Excel number-format helpers for financial-data exports.
//
// Kept free of React / UI imports so it can be unit-tested in isolation.
// The `currency_usd` format renders the per-country currency symbol (€/£/...)
// instead of a hardcoded dollar sign, matching the report's country.

export type ExcelColumnFormat =
  | 'boolean'
  | 'currency_usd'
  | 'currency_rmb'
  | 'currency_rmb_nullable'
  | 'integer'
  | 'percent'
  | 'percent_signed'
  | 'rate'
  | 'text'

/**
 * Resolve an Excel `numFmt` string for a column format.
 *
 * @param format        Column format key.
 * @param currencySymbol Symbol used for `currency_usd` columns (defaults to
 *                       `$`). Pass `€` / `£` for DE / UK reports so the
 *                       rendered amount carries the correct currency mark.
 * @returns Excel number format string, or `null` when no format applies.
 */
export function getExcelNumFmt(
  format: ExcelColumnFormat,
  currencySymbol: string = '$',
): string | null {
  if (format === 'currency_usd')
    return `"${currencySymbol}"#,##0.00;[Red]-"${currencySymbol}"#,##0.00`
  if (format === 'currency_rmb' || format === 'currency_rmb_nullable')
    return '¥#,##0.00;[Red]-¥#,##0.00'
  if (format === 'percent' || format === 'percent_signed') return '0.0%'
  if (format === 'rate') return '0.0000'
  if (format === 'integer') return '#,##0'
  return null
}
