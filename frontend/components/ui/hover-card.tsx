"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface HoverCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'content'> {
  /** 触发显示的子元素 */
  trigger: React.ReactNode
  /** 悬停时显示的内容 */
  content: React.ReactNode
  /** 动画持续时间 (ms) */
  animationDuration?: number
  /** 是否启用放大效果 */
  scaleOnHover?: boolean
  /** 卡片显示位置 */
  side?: "top" | "bottom" | "left" | "right"
  /** 卡片偏移量 */
  sideOffset?: number
}

const HoverCard = React.forwardRef<HTMLDivElement, HoverCardProps>(
  (
    {
      className,
      trigger,
      content,
      animationDuration = 300,
      scaleOnHover = true,
      side = "top",
      sideOffset = 8,
      ...props
    },
    ref
  ) => {
    const [isVisible, setIsVisible] = React.useState(false)
    const timeoutRef = React.useRef<NodeJS.Timeout>()

    const handleMouseEnter = () => {
      // 清除之前的延迟
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      // 立即显示
      setIsVisible(true)
    }

    const handleMouseLeave = () => {
      // 延迟隐藏，提供更好的交互体验
      timeoutRef.current = setTimeout(() => {
        setIsVisible(false)
      }, 150)
    }

    // 清理 timeout
    React.useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
        }
      }
    }, [])

    // 位置样式映射
    const positionStyles = {
      top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
      bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
      left: "right-full top-1/2 -translate-y-1/2 mr-2",
      right: "left-full top-1/2 -translate-y-1/2 ml-2",
    }

    // 箭头位置样式映射
    const arrowStyles = {
      top: "top-full left-1/2 -translate-x-1/2 border-t-card",
      bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-card",
      left: "left-full top-1/2 -translate-y-1/2 border-l-card",
      right: "right-full top-1/2 -translate-y-1/2 border-r-card",
    }

    return (
      <div
        ref={ref}
        className={cn("relative inline-block", className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        {/* 触发元素 */}
        <div className="cursor-pointer">{trigger}</div>

        {/* 悬浮卡片 */}
        <div
          className={cn(
            "absolute z-50 w-fit min-w-[200px] max-w-[320px] rounded-lg border bg-card p-4 shadow-lg",
            "transition-all duration-300 ease-out",
            "opacity-0 invisible transform",
            isVisible && "opacity-100 visible",
            // 位置样式
            positionStyles[side],
            // 悬停时的缩放效果
            isVisible && scaleOnHover && "scale-100",
            !scaleOnHover && "scale-95",
            isVisible &&
              scaleOnHover &&
              side === "top" &&
              "translate-y-1",
            isVisible &&
              scaleOnHover &&
              side === "bottom" &&
              "translate-y-[-1]",
            isVisible &&
              scaleOnHover &&
              side === "left" &&
              "translate-x-1",
            isVisible &&
              scaleOnHover &&
              side === "right" &&
              "translate-x-[-1]"
          )}
          style={{
            transitionDuration: `${animationDuration}ms`,
          }}
        >
          {/* 箭头指示器 */}
          <div
            className={cn(
              "absolute h-0 w-0 border-8 border-transparent",
              arrowStyles[side]
            )}
          />
          {/* 内容 */}
          <div className="relative z-10">{content}</div>
        </div>
      </div>
    )
  }
)

HoverCard.displayName = "HoverCard"

// ============================================
// 预设的卡片变体组件
// ============================================

/**
 * 信息展示型悬停卡片 - 用于显示详细信息
 */
interface InfoHoverCardProps extends Omit<HoverCardProps, "content"> {
  /** 标题 */
  title: string
  /** 描述文本 */
  description?: string
  /** 额外信息 */
  extra?: React.ReactNode
  /** 图标 */
  icon?: React.ReactNode
}

const InfoHoverCard = React.forwardRef<HTMLDivElement, InfoHoverCardProps>(
  ({ title, description, extra, icon, ...props }, ref) => {
    const content = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {icon && (
            <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
          )}
          <h4 className="font-semibold text-sm">{title}</h4>
        </div>
        {description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {description}
          </p>
        )}
        {extra && <div className="pt-1 border-t">{extra}</div>}
      </div>
    )

    return <HoverCard ref={ref} content={content} {...props} />
  }
)

InfoHoverCard.displayName = "InfoHoverCard"

/**
 * 统计型悬停卡片 - 用于显示指标数据
 */
interface StatsHoverCardProps extends Omit<HoverCardProps, "content"> {
  /** 标签 */
  label: string
  /** 当前值 */
  value: string | number
  /** 变化值 (可选) */
  change?: {
    value: string | number
    type: "increase" | "decrease" | "neutral"
  }
  /** 趋势图表 (可选) */
  trend?: React.ReactNode
}

const StatsHoverCard = React.forwardRef<HTMLDivElement, StatsHoverCardProps>(
  ({ label, value, change, trend, ...props }, ref) => {
    const content = (
      <div className="space-y-3">
        {/* 标签和值 */}
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl font-bold mt-1">{value}</p>
        </div>

        {/* 变化值 */}
        {change && (
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded",
                change.type === "increase" &&
                  "text-green-600 bg-green-50 dark:bg-green-950",
                change.type === "decrease" &&
                  "text-red-600 bg-red-50 dark:bg-red-950",
                change.type === "neutral" &&
                  "text-muted-foreground bg-muted"
              )}
            >
              {change.type === "increase" && "↑"}
              {change.type === "decrease" && "↓"}
              {change.value}
            </span>
            <span className="text-xs text-muted-foreground">较上期</span>
          </div>
        )}

        {/* 趋势图表 */}
        {trend && <div className="pt-2 border-t">{trend}</div>}
      </div>
    )

    return <HoverCard ref={ref} content={content} {...props} />
  }
)

StatsHoverCard.displayName = "StatsHoverCard"

/**
 * 用户/头像悬停卡片 - 用于显示用户信息
 */
interface UserHoverCardProps extends Omit<HoverCardProps, "content"> {
  /** 用户名 */
  username: string
  /** 头像 URL */
  avatar?: string
  /** 角色/职位 */
  role?: string
  /** 邮箱 */
  email?: string
  /** 状态 */
  status?: "online" | "offline" | "away"
  /** 额外操作 */
  actions?: React.ReactNode
}

const UserHoverCard = React.forwardRef<HTMLDivElement, UserHoverCardProps>(
  ({ username, avatar, role, email, status, actions, ...props }, ref) => {
    const statusColors = {
      online: "bg-green-500",
      offline: "bg-gray-400",
      away: "bg-yellow-500",
    }

    const content = (
      <div className="space-y-3">
        {/* 用户信息头部 */}
        <div className="flex items-start gap-3">
          <div className="relative">
            {avatar ? (
              <img
                src={avatar}
                alt={username}
                className="w-12 h-12 rounded-full object-cover"
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white font-semibold text-lg">
                {username.charAt(0).toUpperCase()}
              </div>
            )}
            {status && (
              <span
                className={cn(
                  "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card",
                  statusColors[status]
                )}
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold truncate">{username}</h4>
            {role && (
              <p className="text-sm text-muted-foreground truncate">{role}</p>
            )}
          </div>
        </div>

        {/* 邮箱 */}
        {email && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            <span className="truncate">{email}</span>
          </div>
        )}

        {/* 操作按钮 */}
        {actions && <div className="pt-2 border-t">{actions}</div>}
      </div>
    )

    return <HoverCard ref={ref} content={content} {...props} />
  }
)

UserHoverCard.displayName = "UserHoverCard"

export {
  HoverCard,
  type HoverCardProps,
  InfoHoverCard,
  type InfoHoverCardProps,
  StatsHoverCard,
  type StatsHoverCardProps,
  UserHoverCard,
  type UserHoverCardProps,
}
