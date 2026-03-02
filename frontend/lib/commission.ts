export type CommissionBasis = 'sales_amount' | 'cash_received' | 'profit_margin' | string | null | undefined

export const CASH_RECEIVED_COMMISSION_TIERS = [
  { minInclusive: 0.4, maxExclusive: 0.5, rate: 0.07 },
  { minInclusive: 0.5, maxExclusive: 0.6, rate: 0.1 },
  { minInclusive: 0.6, maxExclusive: 0.7, rate: 0.13 },
  { minInclusive: 0.7, maxExclusive: Number.POSITIVE_INFINITY, rate: 0.15 },
] as const

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function normalizeRate(value: number): number {
  const safe = toFiniteNumber(value)
  if (safe <= 0) return 0
  if (safe >= 1) return 1
  return safe
}

export function getCashReceivedCommissionRate(paybackRatio: number): number {
  const ratio = toFiniteNumber(paybackRatio)
  if (ratio < 0.4) return 0
  const tier = CASH_RECEIVED_COMMISSION_TIERS.find((item) => ratio >= item.minInclusive && ratio < item.maxExclusive)
  return tier?.rate ?? 0
}

export function resolveOperationCommissionUsd(params: {
  commissionBasis: CommissionBasis
  configuredCommissionRate: number
  incomeTotalUsd: number
  amazonPaybackUsd: number
}): { commissionRate: number; baseAmountUsd: number; commissionUsd: number } {
  const incomeTotalUsd = toFiniteNumber(params.incomeTotalUsd)
  const amazonPaybackUsd = toFiniteNumber(params.amazonPaybackUsd)

  if (params.commissionBasis === 'cash_received') {
    const paybackRatio = incomeTotalUsd > 0 ? amazonPaybackUsd / incomeTotalUsd : 0
    const commissionRate = getCashReceivedCommissionRate(paybackRatio)
    const baseAmountUsd = amazonPaybackUsd > 0 ? amazonPaybackUsd : 0
    return {
      commissionRate,
      baseAmountUsd,
      commissionUsd: baseAmountUsd * commissionRate,
    }
  }

  const commissionRate = normalizeRate(params.configuredCommissionRate)
  return {
    commissionRate,
    baseAmountUsd: incomeTotalUsd,
    commissionUsd: incomeTotalUsd * commissionRate,
  }
}
