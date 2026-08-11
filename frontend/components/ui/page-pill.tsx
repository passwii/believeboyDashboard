import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * PagePill 页面徽标（BLF-634：PILL 尺寸统一定制）。
 *
 * 统一配方（对齐 BLF-605 跟进 / §4.1 pill 形态）：
 *   - 高度 `h-9`（36px，与右侧操作按钮等高，视觉上同处一条水平线）
 *   - icon 由组件统一为 `h-4 w-4`（与按钮 icon 一致），调用方无需传尺寸类
 *   - `px-4` + `text-xs` + `tracking-[0.14em]` + `rounded-full`
 *   - `border-primary/25` + `bg-primary/10` + `text-primary/90`
 *
 * 适用场景：卡内 console 头部（PILL 左 + 操作按钮右），如
 * `app/dashboard/operations/shipment-management/page.tsx`（BLF-605）。
 * 页面级 eyebrow（`PageHeader` 的 `eyebrow` prop）尺寸更小（px-3 py-1），仍走 PageHeader。
 *
 * 用法：
 * ```tsx
 * <PagePill icon={<Boxes />}>运营 · 补货分析</PagePill>
 * ```
 */
export interface PagePillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 徽标图标（lucide 组件，尺寸由组件统一为 h-4 w-4） */
  icon?: React.ReactNode
}

export function PagePill({ icon, children, className, ...props }: PagePillProps) {
  return (
    <span
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 text-xs font-semibold tracking-[0.14em] text-primary/90',
        className
      )}
      {...props}
    >
      {icon ? <span className="[&>svg]:h-4 [&>svg]:w-4">{icon}</span> : null}
      {children}
    </span>
  )
}

export default PagePill
