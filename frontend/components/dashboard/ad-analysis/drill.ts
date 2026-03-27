export const AD_ANALYSIS_DRILL_PATHS: Record<string, string> = {
  budget: '/dashboard/data-analysis/ad-analysis/budget',
  campaigns: '/dashboard/data-analysis/ad-analysis/campaigns',
  placements: '/dashboard/data-analysis/ad-analysis/placements',
  products: '/dashboard/data-analysis/ad-analysis/products',
  'purchased-products': '/dashboard/data-analysis/ad-analysis/purchased-products',
  'search-terms': '/dashboard/data-analysis/ad-analysis/search-terms',
  'time-trend': '/dashboard/data-analysis/ad-analysis/time-trend',
  'traffic-quality': '/dashboard/data-analysis/ad-analysis/traffic-quality',
}

export const AD_ANALYSIS_DRILL_LABELS: Record<string, string> = {
  budget: '预算',
  campaigns: '活动',
  placements: '广告位',
  products: 'SKU',
  'purchased-products': '关联购买',
  'search-terms': '搜索词',
  'time-trend': '趋势',
  'traffic-quality': '流量',
}

export function getAnalysisDrillLabel(tab?: string | null): string | null {
  if (!tab) return null
  return AD_ANALYSIS_DRILL_LABELS[tab] || null
}

export function buildAnalysisDrillHref(
  tab: string,
  baseParams: {
    projectId?: string
    country?: string
    dateFrom?: string
    dateTo?: string
  },
  extras: Record<string, string | undefined> = {},
): string | null {
  const pathname = AD_ANALYSIS_DRILL_PATHS[tab]
  if (!pathname) return null

  const query = new URLSearchParams()
  if (baseParams.projectId) query.set('projectId', baseParams.projectId)
  if (baseParams.country) query.set('country', baseParams.country)
  if (baseParams.dateFrom) query.set('dateFrom', baseParams.dateFrom)
  if (baseParams.dateTo) query.set('dateTo', baseParams.dateTo)

  Object.entries(extras).forEach(([key, value]) => {
    if (value) query.set(key, value)
  })

  const queryString = query.toString()
  return queryString ? `${pathname}?${queryString}` : pathname
}
