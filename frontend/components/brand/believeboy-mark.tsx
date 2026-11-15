import React from 'react'

import { cn } from '@/lib/utils'

import {
  BELIEVEBOY_MARK_LABELS,
  BELIEVEBOY_MARK_PATHS,
  type BelieveboyMarkDirection,
} from './believeboy-marks'

interface BelieveboyMarkProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'children'> {
  direction?: BelieveboyMarkDirection
  /** 可访问名称；装饰性使用时传 `null` */
  label?: string | null
}

/**
 * 静态 Mark。`GlassIconReveal` 用 SVG 字符串重绘同一个几何，
 * 所以两处必须共享 `believeboy-marks.ts` 的 path 常量。
 */
export function BelieveboyMark({
  direction = 'wing',
  label = BELIEVEBOY_MARK_LABELS[direction],
  className,
  ...props
}: BelieveboyMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      role={label ? 'img' : 'presentation'}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn('block', className)}
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={BELIEVEBOY_MARK_PATHS[direction]}
      />
    </svg>
  )
}

interface BelieveboyLockupProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: BelieveboyMarkDirection
  markSize?: number
  wordmarkSize?: number
  /** 字标写法；草稿里默认小写 `believeboy` */
  word?: string
}

/**
 * 草稿锁合：mark + 小写字标。字标沿用仓库自托管的 Manrope（`--font-sans`），
 * 不引入新的 webfont，也不改登录页已确认的字形。
 */
export function BelieveboyLockup({
  direction = 'wing',
  markSize = 34,
  wordmarkSize = 21,
  word = 'believeboy',
  className,
  ...props
}: BelieveboyLockupProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)} {...props}>
      <BelieveboyMark
        direction={direction}
        label={null}
        style={{ width: markSize, height: markSize, flex: '0 0 auto' }}
      />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: wordmarkSize,
          fontWeight: 600,
          letterSpacing: '0.018em',
          lineHeight: 1,
        }}
      >
        {word}
      </span>
    </div>
  )
}
