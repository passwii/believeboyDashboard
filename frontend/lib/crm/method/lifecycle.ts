import type { LifecycleDistribution } from '@/lib/crm/types'

/** 转化时间漏斗的一档（宽→窄排列）。 */
export interface TimeFunnelStage {
  label: string
  value: number
  displayValue: string
  /** 该档累计占比（0-1）。 */
  pct: number
}

/**
 * 转化时间漏斗（BLF-520「漏斗叠加」）：
 * 从分布的累计占比推出「N 天内转化」各档，宽 → 窄排列：
 * 已转化（全部样本）→ 30 天内 → 14 天内 → 7 天内 → 3 天内 → 1 天内。
 *
 * 档宽 = 累计计数 = round(cumulative_pct × sample_count)，单调递减形成漏斗，
 * 一眼看出转化速度集中在哪个时间窗。无样本返回空数组。
 */
export function buildTimeFunnelStages(
  dist: LifecycleDistribution | undefined
): TimeFunnelStage[] {
  const sample = dist?.summary.sampleCount ?? 0
  if (sample === 0) return []

  const capped = dist!.buckets
    .filter((b) => b.maxDays !== undefined && b.maxDays > 0)
    .slice()
    .reverse()

  return [
    { label: '已转化', value: sample, displayValue: `${sample} 个`, pct: 1 },
    ...capped.map((b) => {
      const count = Math.round(b.cumulativePct * sample)
      return {
        label: `${b.maxDays} 天内`,
        value: count,
        displayValue: `${count} 个`,
        pct: b.cumulativePct,
      }
    }),
  ]
}
