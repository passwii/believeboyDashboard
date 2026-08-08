import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LifecycleBoardSection } from './lifecycle-board'
import type { LifecycleBoard } from '@/lib/crm/types'

function makeDist(
  label: string,
  description: string,
  sampleCount: number,
  totalCount: number,
  counts: number[]
): LifecycleBoard['firstFollow'] {
  const labels = ['1 天内', '1-3 天', '3-7 天', '7-14 天', '14-30 天', '30 天以上']
  const n = Math.max(sampleCount, 1)
  let cumulative = 0
  return {
    metric: label === '首次跟进' ? 'first_follow' : label === '转化' ? 'conversion' : 'churn',
    label,
    description,
    summary: { sampleCount, totalCount, avgDays: 3.2, medianDays: 2.0, p90Days: 12.5, maxDays: 45 },
    buckets: labels.map((l, i) => {
      cumulative += counts[i] ?? 0
      return {
        label: l,
        minDays: i === 0 ? 0 : [1, 3, 7, 14, 30][i - 1],
        maxDays: i === labels.length - 1 ? undefined : [1, 3, 7, 14, 30][i],
        count: counts[i] ?? 0,
        pct: Math.round(((counts[i] ?? 0) / n) * 10000) / 10000,
        cumulativePct: Math.round((cumulative / n) * 10000) / 10000,
      }
    }),
  }
}

const board: LifecycleBoard = {
  firstFollow: makeDist('首次跟进', '客户创建 → 第一条跟进记录', 20, 30, [10, 5, 3, 1, 1, 0]),
  conversion: makeDist('转化', '线索创建 → 转化完成（线索转客户）', 10, 40, [5, 3, 1, 1, 0, 0]),
  churn: makeDist('流失', '客户创建 → 首次回公海', 8, 30, [1, 2, 3, 1, 1, 0]),
  nowInSea: 5,
}

describe('LifecycleBoardSection（生命周期看板，BLF-520）', () => {
  it('渲染三种分布卡片 + 摘要 chips + 公海快照', () => {
    render(<LifecycleBoardSection board={board} />)
    expect(screen.getByText('生命周期')).toBeTruthy()
    expect(screen.getByText('首次跟进')).toBeTruthy()
    expect(screen.getByText('转化')).toBeTruthy()
    expect(screen.getByText('流失')).toBeTruthy()
    // 公海快照 chip
    expect(screen.getByText('当前公海 5 家')).toBeTruthy()
    // 摘要 chips：样本 20 / 总体 30；三张卡片均值同为 3.2 天
    expect(screen.getByText('20')).toBeTruthy()
    expect(screen.getAllByText('3.2 天').length).toBe(3)
    // 桶标签缩写
    expect(screen.getAllByText('30 天+').length).toBeGreaterThan(0)
  })

  it('转化卡片叠加「转化时间漏斗」', () => {
    render(<LifecycleBoardSection board={board} />)
    expect(screen.getByText('转化时间漏斗（漏斗叠加）')).toBeTruthy()
    // 漏斗档位：已转化（唯一文案）→ 30 天内
    expect(screen.getByText('已转化')).toBeTruthy()
    expect(screen.getAllByText('30 天内').length).toBeGreaterThan(0)
  })

  it('无数据分布显示「暂无数据」且不画漏斗', () => {
    const empty = {
      ...board,
      conversion: makeDist('转化', '线索创建 → 转化完成（线索转客户）', 0, 40, [0, 0, 0, 0, 0, 0]),
    }
    render(<LifecycleBoardSection board={empty} />)
    expect(screen.getAllByText('暂无数据').length).toBeGreaterThan(0)
    expect(screen.queryByText('转化时间漏斗（漏斗叠加）')).toBeNull()
  })

  it('loading 时显示加载中', () => {
    render(<LifecycleBoardSection board={null} loading />)
    expect(screen.getByText('加载中…')).toBeTruthy()
  })
})
