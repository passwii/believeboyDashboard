/**
 * P6a 价值评分共享常量 + 纯函数 computeRating（前后端一致）。
 *
 * 4 维 ABCD 主观打分 → 等权汇总 A/B/C/D。
 * 与后端 value_score_service.compute_rating 逻辑完全一致。
 */

export type Grade = 'A' | 'B' | 'C' | 'D'
export const GRADE_OPTIONS: Grade[] = ['A', 'B', 'C', 'D']
export const GRADE_POINTS: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 }

export type ScoreKey = 'score_scale' | 'score_pay' | 'score_fit' | 'score_coop'

export const SCORE_FIELDS: { key: ScoreKey; label: string; tooltip: string }[] = [
  {
    key: 'score_scale',
    label: '体量与潜力',
    tooltip:
      '客户自身业务规模、所在产品类目的跨境销售体量、增长空间。盘子越大、品类越适合跨境、增长越快 → 评得越高。',
  },
  {
    key: 'score_pay',
    label: '付费能力与意愿',
    tooltip:
      '客户有没有预算、愿不愿意为运营服务持续付费。既有支付能力又有长期付费意愿 → 高；只谈价、预算紧、付费犹豫 → 低。',
  },
  {
    key: 'score_fit',
    label: '跨境匹配度',
    tooltip:
      '客户对跨境电商的认知、投入决心、产品与团队适配度。懂跨境、舍得投入、产品适合出海 → 高；完全外行、观望试探 → 低。',
  },
  {
    key: 'score_coop',
    label: '合作性',
    tooltip:
      '对接是否顺畅、决策链是否清晰、配合度与沟通成本。对接人稳定、决策快、配合好 → 高；需求反复、决策混乱、难沟通 → 低。',
  },
]

export const GRADE_COLOR: Record<Grade, string> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  B: 'bg-sky-100 text-sky-800 dark:bg-sky-800/40 dark:text-sky-200',
  C: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  D: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
}

export const DEFAULT_WEIGHTS: Record<ScoreKey, number> = {
  score_scale: 0.25,
  score_pay: 0.25,
  score_fit: 0.25,
  score_coop: 0.25,
}

export type ScoreMap = Partial<Record<ScoreKey, Grade | null>>

export function computeRating(
  scores: ScoreMap,
  weights?: Record<ScoreKey, number>
): Grade | null {
  const w = weights ?? DEFAULT_WEIGHTS
  for (const f of SCORE_FIELDS) if (scores[f.key] == null) return null
  const sum = SCORE_FIELDS.reduce(
    (acc, f) => acc + GRADE_POINTS[scores[f.key] as Grade] * w[f.key],
    0
  )
  if (sum >= 3.5) return 'A'
  if (sum >= 2.5) return 'B'
  if (sum >= 1.5) return 'C'
  return 'D'
}