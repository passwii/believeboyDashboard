export function daysSince(iso?: string): number {
 if (!iso) return Number.POSITIVE_INFINITY
 const then = new Date(iso).getTime()
 if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
 return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24))
}

export function formatRelativeTime(iso?: string): string {
 const days = daysSince(iso)
 if (!Number.isFinite(days)) return '-'
 if (days === 0) return '今天'
 if (days === 1) return '昨天'
 if (days < 30) return `${days} 天前`
 if (days < 365) return `${Math.floor(days / 30)} 个月前`
 return `${Math.floor(days / 365)} 年前`
}

export function isOverdueForFollow(iso?: string, thresholdDays = 7): boolean {
 const days = daysSince(iso)
 return Number.isFinite(days) && days > thresholdDays
}