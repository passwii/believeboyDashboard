import type { CommissionProjectMonth, ExchangeRate, ProjectRow, SiteCode } from './types'
import { SITE_ORDER } from './types'

export const COUNTRY_TO_CURRENCY: Record<SiteCode, string> = {
  US: 'USD',
  DE: 'EUR',
  UK: 'GBP',
}

export const SITE_INFO: Record<SiteCode, { label: string; dotClass: string }> = {
  US: { label: 'US', dotClass: 'bg-blue-500' },
  DE: { label: 'DE', dotClass: 'bg-purple-500' },
  UK: { label: 'UK', dotClass: 'bg-green-500' },
}

export const SITE_BORDER_COLORS: Record<SiteCode, string> = {
  US: 'border-l-blue-500',
  DE: 'border-l-purple-500',
  UK: 'border-l-green-500',
}

export function convertToUsd(
  amount: number,
  country: SiteCode,
  exchangeRates: ExchangeRate[]
): number {
  if (country === 'US') return amount

  const rateMap = new Map(exchangeRates.map(r => [r.currency, r.rate]))
  const getRate = (currency: string): number => rateMap.get(currency) ?? 0

  const localCurrency = COUNTRY_TO_CURRENCY[country]
  if (!localCurrency) return amount

  const localRate = getRate(localCurrency)
  const usdRate = getRate('USD')

  if (!localRate || !usdRate || usdRate === 0) return amount

  const cnyAmount = amount * localRate
  return cnyAmount / usdRate
}

export function groupProjectsBySites(
  rows: CommissionProjectMonth[]
): ProjectRow[] {
  const groupsMap = new Map<number, CommissionProjectMonth[]>()
  const nameMap = new Map<number, string>()

  for (const row of rows) {
    if (!groupsMap.has(row.project_id)) {
      groupsMap.set(row.project_id, [])
      nameMap.set(row.project_id, row.project_name)
    }
    groupsMap.get(row.project_id)!.push(row)
  }

  const result: ProjectRow[] = []

  for (const [projectId, siteRows] of groupsMap) {
    const projectName = nameMap.get(projectId)!
    // 按 SITE_ORDER 排序，确保站点顺序一致
    const sortedRows = siteRows.sort((a, b) => {
      return SITE_ORDER.indexOf(a.country as SiteCode) - SITE_ORDER.indexOf(b.country as SiteCode)
    })

    sortedRows.forEach((record, index) => {
      result.push({
        projectId,
        projectName,
        // 只有第一行显示项目名
        rowSpan: index === 0 ? sortedRows.length : 0,
        record,
      })
    })
  }

  return result.sort((a, b) => a.projectId - b.projectId)
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

export function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${(value * 100).toFixed(2)}%`
}

export function formatIncomeWithCurrency(amount: number, country: SiteCode): string {
  const symbols: Record<SiteCode, { symbol: string; currency: string }> = {
    US: { symbol: '$', currency: 'USD' },
    DE: { symbol: '€', currency: 'EUR' },
    UK: { symbol: '£', currency: 'GBP' },
  }
  const { symbol, currency } = symbols[country]
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${symbol}${formatted} ${currency}`
}
