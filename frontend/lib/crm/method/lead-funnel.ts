/**
 * 线索漏斗（累计转化口径）构建工具。
 *
 * 看板漏斗**不**按"当前各状态快照"取数——那样会忽宽忽窄：例如联系中的
 * 线索可能比新线索还多，漏斗第二级反而变宽，视觉上像坏掉了。
 *
 * 改为**累计转化漏斗**：每一层 = 到达该阶段及以上的线索数，逐级收窄，
 * 符合漏斗"层层筛选"的本质：
 *
 *   线索总量 = new + contacting + qualified + converted
 *   跟进联系 = contacting + qualified + converted
 *   验证     = qualified + converted
 *   转化     = converted
 *
 * 第一级"线索总量"即漏斗入口——所有流入系统的线索（不含弃置）；
 * 「已弃置」是侧面流失信号，不进主漏斗，由页面单独展示。
 */
import type { FunnelGradientStop, FunnelStage } from '@/components/ui/funnel-chart'

/** 漏斗取数来源：后端 / mock 的 leadFunnel（各状态当前计数）。 */
export type LeadFunnelCounts = Record<string, number>

/** 从冷到暖收口到成功绿：青 → 天蓝 → 蓝绿 → 翠绿。 */
const gradient = (from: string, to: string): FunnelGradientStop[] => [
  { offset: 0, color: from },
  { offset: 1, color: to },
]

/**
 * 把各状态计数折算成累计漏斗四档。
 * 即使输入为空也返回完整四档结构（值全 0），调用方用首档值判断是否展示。
 */
export function buildLeadFunnelStages(counts: LeadFunnelCounts): FunnelStage[] {
  const n = counts.new ?? 0
  const c = counts.contacting ?? 0
  const q = counts.qualified ?? 0
  const v = counts.converted ?? 0

  return [
    { label: '线索总量', value: n + c + q + v, gradient: gradient('#38bdf8', '#0ea5e9') },
    { label: '跟进联系', value: c + q + v, gradient: gradient('#22d3ee', '#06b6d4') },
    { label: '验证', value: q + v, gradient: gradient('#2dd4bf', '#14b8a6') },
    { label: '转化', value: v, gradient: gradient('#34d399', '#10b981') },
  ]
}

/** 整体转化率 = 转化 / 线索总量；总量为 0 时返回 null（页面不展示）。 */
export function leadConversionRate(counts: LeadFunnelCounts): number | null {
  const total = (counts.new ?? 0) + (counts.contacting ?? 0) + (counts.qualified ?? 0) + (counts.converted ?? 0)
  if (total === 0) return null
  return (counts.converted ?? 0) / total
}


/**
 * 相邻阶段的逐级转化率：第 i 项 = stages[i+1].value / stages[i].value。
 * 返回长度 = stages.length - 1；前档值为 0 时该项为 null（调用方展示为 "—"）。
 * 用于定位漏斗卡点：哪一级流转效率最低。
 */
export function leadFunnelStepRates(stages: FunnelStage[]): (number | null)[] {
  const rates: (number | null)[] = []
  for (let i = 0; i < stages.length - 1; i++) {
    const from = stages[i]?.value ?? 0
    const to = stages[i + 1]?.value ?? 0
    rates.push(from > 0 ? to / from : null)
  }
  return rates
}
