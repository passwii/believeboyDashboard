export interface SkuScopeOption {
  sku: string
}

export interface DailyAnalysisExportState {
  exporting: boolean
  loading: boolean
  skuLoading: boolean
  hasData: boolean
}

export function buildSkuScopeKey(
  projectId: string | number | null | undefined,
  country: string | null | undefined
): string | null {
  const normalizedProjectId = String(projectId ?? '').trim()
  const normalizedCountry = String(country ?? '').trim().toUpperCase()
  if (!normalizedProjectId || !normalizedCountry || normalizedCountry === 'ALL') return null
  return `${normalizedProjectId}:${normalizedCountry}`
}

export function filterRowsBySkuScope<T extends { sku: string }>(
  rows: readonly T[],
  skuOptions: readonly SkuScopeOption[],
  optionsScope: string | null,
  currentScope: string | null
): T[] {
  if (!currentScope || optionsScope !== currentScope || skuOptions.length === 0) {
    return Array.from(rows)
  }

  const activeSkus = new Set(skuOptions.map((option) => option.sku))
  return rows.filter((row) => activeSkus.has(row.sku))
}

export function shouldAcceptSkuOptions(
  requestId: number,
  currentRequestId: number,
  requestScope: string | null,
  currentScope: string | null
): boolean {
  return requestId === currentRequestId && requestScope === currentScope
}

export function isDailyAnalysisExportBusy(state: DailyAnalysisExportState): boolean {
  return state.exporting || state.loading || state.skuLoading || !state.hasData
}
