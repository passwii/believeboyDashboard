import type * as React from 'react'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  clampRingValue,
  GoalProgressRings,
  projectedMonthlyRate,
  type GoalRingItem,
} from './goal-progress-rings'

// framer-motion 在 jsdom 下不需要真实动画，mock 成纯 div 即可稳定断言
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return {
    ...actual,
    motion: {
      div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
        <div data-motion="true" {...props}>
          {children}
        </div>
      ),
      circle: ({ children, ...props }: React.SVGProps<SVGCircleElement>) => (
        <circle data-motion="true" {...props}>
          {children}
        </circle>
      ),
    },
    useReducedMotion: () => false,
  }
})

const ITEMS: GoalRingItem[] = [
  {
    key: 'pace',
    label: '截止今日完成率',
    value: 0.863,
    display: '86.3%',
    caption: '已完成 $1,700 / 应完成 $1,970',
    color: 'hsl(var(--chart-1))',
  },
  {
    key: 'monthly',
    label: '实际月度进度',
    value: 0.4,
    display: '40.0%',
    caption: '已完成 $1,700 / 目标 $4,250',
    note: '占整月目标的实际比例',
    color: 'hsl(var(--chart-2))',
  },
  {
    key: 'projected',
    label: '预估月度完成率',
    value: 1.25,
    display: '125.0%',
    caption: '按当前节奏预计月末达成',
    note: '线性预估，仅供参考',
    color: 'hsl(var(--chart-3))',
  },
]

describe('clampRingValue（环弧长 0-1 封顶）', () => {
  it('正常值原样返回', () => {
    expect(clampRingValue(0)).toBe(0)
    expect(clampRingValue(0.863)).toBe(0.863)
    expect(clampRingValue(1)).toBe(1)
  })
  it('超额值封顶到 1，负值截断到 0', () => {
    expect(clampRingValue(1.25)).toBe(1)
    expect(clampRingValue(3)).toBe(1)
    expect(clampRingValue(-0.5)).toBe(0)
  })
  it('非有限数（NaN/Infinity）归 0', () => {
    expect(clampRingValue(Number.NaN)).toBe(0)
    expect(clampRingValue(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('projectedMonthlyRate（预估月度完成率线性外推）', () => {
  it('15 号完成整月目标 40% → 预估 80%', () => {
    expect(projectedMonthlyRate(0.4, 30, 15)).toBeCloseTo(0.8)
  })
  it('10 号完成 50% → 预估 150%（30 天月）', () => {
    expect(projectedMonthlyRate(0.5, 30, 10)).toBeCloseTo(1.5)
  })
  it('月末最后一天 → 预估等于实际进度', () => {
    expect(projectedMonthlyRate(0.9, 30, 30)).toBeCloseTo(0.9)
  })
  it('非当前月（today_day=0）或无目标 → 0', () => {
    expect(projectedMonthlyRate(0.5, 30, 0)).toBe(0)
    expect(projectedMonthlyRate(0, 30, 15)).toBe(0)
    expect(projectedMonthlyRate(Number.NaN, 30, 15)).toBe(0)
  })
})

describe('GoalProgressRings 渲染（BLF-595 合并式三环）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染全部指标：标签 + 展示值 + 说明文字（右侧指标块）', () => {
    render(<GoalProgressRings items={ITEMS} />)
    expect(screen.getByText('截止今日完成率')).toBeInTheDocument()
    expect(screen.getByText('86.3%')).toBeInTheDocument()
    expect(screen.getByText('已完成 $1,700 / 应完成 $1,970')).toBeInTheDocument()
    expect(screen.getByText('预估月度完成率')).toBeInTheDocument()
    expect(screen.getByText('125.0%')).toBeInTheDocument()
    expect(screen.getByText('线性预估，仅供参考')).toBeInTheDocument()
  })

  it('合并式布局：一个圆形容器内嵌套 3 个同心环，右侧为指标说明（桌面 3 列横排）', () => {
    const { container } = render(<GoalProgressRings items={ITEMS} />)
    // 左侧圆形容器：唯一一个带 data-testid 的容器
    const ringsContainer = screen.getByTestId('goal-rings-concentric')
    // 3 个同心环 svg 都叠在该容器内（同心叠加，而非 3 列摊开）
    const ringSvgs = container.querySelectorAll('svg[aria-label]')
    expect(ringSvgs.length).toBe(3)
    for (const svg of Array.from(ringSvgs)) {
      expect(ringsContainer.contains(svg)).toBe(true)
    }
    // 右侧 3 个指标块
    expect(screen.getByText('截止今日完成率')).toBeInTheDocument()
    expect(screen.getByText('实际月度进度')).toBeInTheDocument()
    expect(screen.getByText('预估月度完成率')).toBeInTheDocument()
  })

  it('右侧指标块桌面端为 3 列横排（BLF-595 调整），手机端单列', () => {
    const { container } = render(<GoalProgressRings items={ITEMS} />)
    // 指标说明网格：grid + 移动端 1 列 + sm 起 3 列
    const grid = container.querySelector('.grid')
    expect(grid).not.toBeNull()
    expect(grid!.className).toContain('grid-cols-1')
    expect(grid!.className).toContain('sm:grid-cols-3')
    // 3 个指标块是网格的直接子项（横向三列布局）
    const directChildren = Array.from(grid!.children)
    expect(directChildren.length).toBe(3)
  })

  it('每个环带 aria-label（可访问性）', () => {
    render(<GoalProgressRings items={ITEMS} />)
    expect(screen.getByRole('img', { name: '截止今日完成率：86.3%' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '实际月度进度：40.0%' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '预估月度完成率：125.0%' })).toBeInTheDocument()
  })

  it('value >= 1 的指标显示「超额」徽标', () => {
    render(<GoalProgressRings items={ITEMS} />)
    expect(screen.getByText('超额')).toBeInTheDocument()
  })

  it('items 为空时不渲染', () => {
    const { container } = render(<GoalProgressRings items={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
