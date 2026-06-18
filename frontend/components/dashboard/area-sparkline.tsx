'use client'

/**
 * 通用迷你面积折线图 (AreaSparkline)
 *
 * 从 dashboard-metric-tiles.tsx 提取,供其它 dashboard 组件(如 DashboardHealthKpis)
 * 复用同一套视觉口径:viewBox="0 0 100 100" + preserveAspectRatio="none",
 * 外层容器只要给任意 height/width 即可自适应。
 *
 * 用法:
 *   <div className="h-10 w-20">
 *     <AreaSparkline trend={trend} gradientId="health-impressions"
 *                    strokeColor="hsl(var(--chart-2))" />
 *   </div>
 */

import { useState } from 'react'

/** trend → SVG point,归一化到 (x∈[0,100], y∈[6,94]) */
export function toSvgPoints(trend: number[]): Array<{ x: number; y: number }> {
  const max = Math.max(...trend, 1)
  const min = Math.min(...trend)
  const range = Math.max(max - min, 1)
  return trend.map((point, index) => ({
    x: (index / Math.max(trend.length - 1, 1)) * 100,
    y: 100 - ((point - min) / range) * 76 - 6,
  }))
}

export function buildPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

export function buildAreaPath(points: Array<{ x: number; y: number }>): string {
  const curve = buildPath(points)
  if (!curve) return ''
  return `${curve} L ${points[points.length - 1].x} 100 L ${points[0].x} 100 Z`
}

export interface AreaSparklineProps {
  trend: number[]
  /** SVG <linearGradient id> 后缀,同页多实例必须唯一 */
  gradientId: string
  /** 线条颜色 (CSS color / hsl(...)) */
  strokeColor: string
  strokeWidth?: number
  /** 鼠标悬停 tooltip 显示的日期标签 */
  labels?: string[]
  /** 自定义 tooltip 显示格式 */
  formatValue?: (value: number) => string
}

export function AreaSparkline({
  trend,
  gradientId,
  strokeColor,
  strokeWidth = 2.5,
  labels,
  formatValue = (v: number) => String(v),
}: AreaSparklineProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const points = toSvgPoints(trend)

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100

    const segmentWidth = 100 / Math.max(trend.length - 1, 1)
    const index = Math.round(x / segmentWidth)
    setHoveredIndex(Math.min(index, trend.length - 1))
  }

  const handleMouseLeave = () => {
    setHoveredIndex(null)
  }

  const hoveredPoint = hoveredIndex !== null ? points[hoveredIndex] : null

  return (
    <div
      className="relative w-full h-full"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            bottom: 'calc(100% + 6px)',
            left: `${(hoveredIndex / Math.max(trend.length - 1, 1)) * 100}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="bg-foreground text-background text-[11px] font-medium rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-lg">
            {labels?.[hoveredIndex] && (
              <span className="opacity-60">{labels[hoveredIndex]} · </span>
            )}
            <span>{formatValue(trend[hoveredIndex])}</span>
          </div>
        </div>
      )}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full"
        style={{ cursor: 'pointer' }}
      >
        <defs>
          <linearGradient id={`spark-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity={0.28} />
            <stop offset="100%" stopColor={strokeColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={buildAreaPath(points)} fill={`url(#spark-fill-${gradientId})`} />
        <path
          d={buildPath(points)}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoveredPoint && (
          <>
            <line
              x1={hoveredPoint.x}
              y1={0}
              x2={hoveredPoint.x}
              y2={100}
              stroke={strokeColor}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.35}
            />
            <circle
              cx={hoveredPoint.x}
              cy={hoveredPoint.y}
              r={3.5}
              fill={strokeColor}
              stroke="white"
              strokeWidth={2}
            />
          </>
        )}
      </svg>
    </div>
  )
}