import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * PageHeader 原语（BLF-503 §8 页面模式）：页面级头部 = eyebrow + 标题 + 描述 + 操作区。
 * 对齐 `docs/FRONTEND-DESIGN-SPEC.md` §4.1 两种形态：
 *   - `eyebrow`（pill 形态）：带 icon 的胶囊小标，如 `<Store /> 运营导航 · 站点导航`
 *   - `kicker`（kicker 形态）：`dashboard-kicker` 小标文字，如 `操作台账`
 * 两者可只传其一；标题 `title` 可选（如 site-navigation 只有 pill + 描述）。
 * `actions` 放右侧操作区（按钮 / 轻量统计 / 筛选），自动 flex-wrap。
 *
 * 布局：`flex flex-wrap items-start justify-between gap-5`（§4.1 页面级头部布局）。
 * 本组件不包卡片外壳（页面按需包 `dashboard-surface`），保证可组合。
 */
export interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  /** 页面主标题（h1，`--font-display` 自动应用） */
  title?: string
  /** Eyebrow pill 形态内容（ReactNode，通常带 icon），与 `kicker` 二选一 */
  eyebrow?: React.ReactNode
  /** Kicker 小标文字（dashboard-kicker 类），与 `eyebrow` 二选一 */
  kicker?: string
  /** 描述文字 */
  description?: React.ReactNode
  /** 右侧操作区（按钮 / 统计 / 筛选） */
  actions?: React.ReactNode
  /** 左侧标题/描述区的额外类（默认 max-w-2xl space-y-3） */
  contentClassName?: string
}

export function PageHeader({
  title,
  eyebrow,
  kicker,
  description,
  actions,
  className,
  contentClassName,
  ...props
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-5', className)} {...props}>
      <div className={cn('max-w-2xl space-y-3', contentClassName)}>
        {eyebrow ? (
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90">
            {eyebrow}
          </p>
        ) : null}
        {kicker ? <p className="dashboard-kicker">{kicker}</p> : null}
        {title ? (
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        ) : null}
        {description ? (
          <p className="text-sm leading-6 text-muted-foreground md:text-base">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  )
}

export default PageHeader
