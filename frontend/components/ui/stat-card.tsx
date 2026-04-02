import * as React from "react"
import { ArrowDownRight, ArrowUpRight } from "lucide-react"

import { cn } from "@/lib/utils"

interface StatCardProps {
  title: string
  value: string
  rawValue?: number
  icon: React.ReactNode
  color: "emerald" | "rose" | "sky" | "amber"
  trend?: number
  trendLabel?: string
  className?: string
}

const colorClasses = {
  emerald: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    gradient: "from-emerald-500/5",
    icon: "text-emerald-600",
  },
  rose: {
    bg: "bg-rose-500/10",
    border: "border-rose-500/20",
    text: "text-rose-600 dark:text-rose-400",
    gradient: "from-rose-500/5",
    icon: "text-rose-600",
  },
  sky: {
    bg: "bg-sky-500/10",
    border: "border-sky-500/20",
    text: "text-sky-600 dark:text-sky-400",
    gradient: "from-sky-500/5",
    icon: "text-sky-600",
  },
  amber: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    gradient: "from-amber-500/5",
    icon: "text-amber-600",
  },
}

function StatCard({
  title,
  value,
  icon,
  color,
  trend,
  trendLabel,
  className,
}: StatCardProps) {
  const colors = colorClasses[color]

  return (
    <div
      className={cn(
        "dashboard-surface hover-lift animate-enter border relative overflow-hidden",
        colors.border,
        className
      )}
    >
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-br via-transparent to-transparent opacity-60 dark:opacity-35",
          colors.gradient
        )}
      />
      <div className="relative z-10 flex flex-row items-start justify-between space-y-0 px-4 pb-3 pt-4">
        <div
          className={cn(
            "text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          )}
        >
          {title}
        </div>
        <div className={cn("rounded-lg p-2", colors.bg, colors.icon)}>
          {icon}
        </div>
      </div>
      <div className="relative z-10 px-4 pb-4 pt-0">
        <div
          className={cn(
            "text-2xl font-semibold tracking-tight md:text-[1.7rem]",
            colors.text
          )}
        >
          {value}
        </div>
        {trend !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center",
                trend >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              )}
            >
              {trend >= 0 ? (
                <ArrowUpRight className="mr-1 h-3 w-3" />
              ) : (
                <ArrowDownRight className="mr-1 h-3 w-3" />
              )}
              {Math.abs(trend).toFixed(1)}%
            </span>
            <span className="ml-1">{trendLabel || "较上期"}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

export { StatCard }
export type { StatCardProps }
