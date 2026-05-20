import type { CommissionProjectMonth, ExchangeRate, ProjectGroup, SiteRow, SiteCode } from './types'
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
): ProjectGroup[] {
  const groupsMap = new Map<number, CommissionProjectMonth[]>()
  const nameMap = new Map<number, string>()

  for (const row of rows) {
    if (!groupsMap.has(row.project_id)) {
      groupsMap.set(row.project_id, [])
      nameMap.set(row.project_id, row.project_name)
    }
    groupsMap.get(row.project_id)!.push(row)
  }

  const result: ProjectGroup[] = []

  for (const [projectId, siteRows] of groupsMap) {
    const projectName = nameMap.get(projectId)!
    const siteSet = new Set(siteRows.map(r => r.country))

    const isSingleUS = siteSet.size === 1 && siteSet.has('US')

    const sites: SiteRow[] = SITE_ORDER.map(country => {
      const record = siteRows.find(r => r.country === country)
      return {
        country,
        hasData: !!record,
        record,
      }
    })

    result.push({
      projectId,
      projectName,
      isSingleUS,
      sites,
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
