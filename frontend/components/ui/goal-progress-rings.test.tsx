import type * as React from 'react'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  achievementPaceRatio,
  clampRingValue,
  GoalProgressRings,
  GoalProgressStat,
  isGoalProgressScopeValid,
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
    shortLabel: '进度',
    value: 0.863,
    display: '86.3%',
    caption: '已完成 $1,700 / 应完成 $1,970',
    color: 'hsl(var(--chart-1))',
  },
  {
    key: 'monthly',
    label: '实际月度进度',
    shortLabel: '月度',
    value: 0.4,
    display: '40.0%',
    caption: '已完成 $1,700 / 目标 $4,250',
    note: '占整月目标的实际比例',
    color: 'hsl(var(--chart-2))',
  },
  {
    key: 'pace_ratio',
    label: '达成速度',
    shortLabel: '速度',
    value: 1.25,
    display: '125.0%',
    caption: '当前日均 / 剩余所需日均',
    note: '≥100% 表示按当前节奏可追平目标',
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

describe('achievementPaceRatio（达成速度）', () => {
  it('当前日均高于剩余所需日均时返回超额比例', () => {
    expect(achievementPaceRatio(400, 1000, 10, 30)).toBeCloseTo(4 / 3)
  })

  it('当前日均低于剩余所需日均时返回实际比例', () => {
    expect(achievementPaceRatio(200, 1000, 10, 30)).toBeCloseTo(0.5)
  })

  it('当前日均高于剩余所需日均时保留超出部分', () => {
    expect(achievementPaceRatio(500, 1000, 10, 30)).toBeCloseTo(2)
  })

  it('已经完成目标时返回 100%', () => {
    expect(achievementPaceRatio(1100, 1000, 10, 30)).toBe(1)
  })

  it('没有剩余天数且尚未达标时返回 0', () => {
    expect(achievementPaceRatio(900, 1000, 30, 30)).toBe(0)
  })

  it('缺少有效目标或日期时返回 null', () => {
    expect(achievementPaceRatio(100, 0, 10, 30)).toBeNull()
    expect(achievementPaceRatio(100, 1000, 0, 30)).toBeNull()
    expect(achievementPaceRatio(100, 1000, 10, 0)).toBeNull()
    expect(achievementPaceRatio(Number.NaN, 1000, 10, 30)).toBeNull()
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
    expect(screen.getByText('达成速度')).toBeInTheDocument()
    expect(screen.getByText('125.0%')).toBeInTheDocument()
    expect(screen.getByText('≥100% 表示按当前节奏可追平目标')).toBeInTheDocument()
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
    expect(screen.getByText('达成速度')).toBeInTheDocument()
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
    expect(screen.getByRole('img', { name: '达成速度：125.0%' })).toBeInTheDocument()
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

describe('isGoalProgressScopeValid（daily-analysis 目标入口范围）', () => {
  it('仅允许具体项目与 US/DE/UK 单站点', () => {
    expect(isGoalProgressScopeValid('7', 'US')).toBe(true)
    expect(isGoalProgressScopeValid('42', 'DE')).toBe(true)
    expect(isGoalProgressScopeValid('9', 'UK')).toBe(true)
  })

  it('聚合项目、聚合站点和空项目不允许展示目标入口', () => {
    expect(isGoalProgressScopeValid('all', 'US')).toBe(false)
    expect(isGoalProgressScopeValid('7', 'ALL')).toBe(false)
    expect(isGoalProgressScopeValid('', 'US')).toBe(false)
    expect(isGoalProgressScopeValid('all', 'ALL')).toBe(false)
  })
})

describe('GoalProgressStat（daily-analysis stats 目标入口）', () => {
  it('展示三个百分比、简称并链接到目标管理页', () => {
    render(<GoalProgressStat href="/dashboard/operations/project-goals?project=7&country=US" items={ITEMS} />)

    const link = screen.getByRole('link', { name: '查看目标管理' })
    expect(link).toHaveAttribute('href', '/dashboard/operations/project-goals?project=7&country=US')
    expect(screen.getByText('目标进度')).toBeInTheDocument()
    expect(screen.getByText('进度')).toBeInTheDocument()
    expect(screen.getByText('86.3%')).toBeInTheDocument()
    expect(screen.getByText('月度')).toBeInTheDocument()
    expect(screen.getByText('40.0%')).toBeInTheDocument()
    expect(screen.getByText('速度')).toBeInTheDocument()
    expect(screen.getByText('125.0%')).toBeInTheDocument()
    expect(link.querySelectorAll('svg')).toHaveLength(3)
  })

  it('加载中保留入口并显示加载状态', () => {
    render(<GoalProgressStat href="/dashboard/operations/project-goals" items={[]} loading />)

    expect(screen.getByRole('link', { name: '查看目标管理' })).toBeInTheDocument()
    expect(screen.getByText('加载中')).toBeInTheDocument()
  })
})
