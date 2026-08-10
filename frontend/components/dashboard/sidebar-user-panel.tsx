'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import {
  Bell,
  Check,
  ChevronRight,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Pin,
  PinOff,
  SunMedium,
  UserCog,
  X,
} from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NotificationListView } from '@/components/notifications/notification-list-view'
import { useServerNotifications } from '@/components/notifications/server-notifications-context'
import { cn } from '@/lib/utils'

interface SidebarUserPanelProps {
  user: {
    name: string
    email: string
    avatar?: string
    roleType?: string
  }
  pinned: boolean
  onClose: () => void
  onPinToggle: () => void
  onLogout: () => void
}

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  operator: '运营',
  businessdev: '招商',
}

function getRoleLabel(roleType: string | undefined): string | null {
  if (!roleType) return null
  return ROLE_LABELS[roleType] ?? null
}

/**
 * 底部 user 区扩展面板：与 SidebarPanel 共用同一套容器 chrome（240×h-screen，
 * 56px header + flex-1 body），但 body 内容是用户信息 + 主题 + 操作。
 *
 * 交互：与 7 个一级 group 走同一套 panelState 状态机：
 * - mouse leave rail+column 150ms 延迟关闭
 * - Pin 按钮锁定，导航后仍开
 * - X 按钮立即关闭
 *
 * 通知视图（BLF-603）：通知入口从正文右上角浮动铃铛迁移至此。
 * - 账户视图的「通知」行（Bell 图标 + 未读徽标）点击后切换到通知列表视图，
 *   列表在面板内部直接渲染（不用悬浮 Popover——portal 会逃出 sidebar 的
 *   mouseleave 区域，导致面板关闭连带弹层消失）。
 * - 视图切换用本地 state，面板关闭即卸载重置；Pin 固定时跨路由保留。
 * - 未读数来自全局 ServerNotificationsProvider（layout 级 30s 轮询）。
 *
 * 性能要点：
 * - React.memo + 默认浅比较：user / 回调引用稳定时，路由切换不会重渲染本组件。
 * - 不订阅 usePathname()：本面板内容（用户信息、主题、退出登录）与路由无关。
 * - 揭幕动画：纯 CSS（globals.css .sidebar-panel-reveal，opacity + translateY），
 *   零 JS 动画运行时；分区跟随面板一起出现，与标准案例一致。
 *
 * 设计（BLF-608）：账户视图顶部为渐变身份卡（蓝→靛蓝 wash + 装饰辉光 +
 *   环形方形头像 + 主色角色徽章），分区标题改为「标签 + 发丝分割线」，
 *   主题切换升级为分段控件（当前段抬起），操作行图标 hover 变主色、
 *   链接行右缘 chevron 提示、退出登录用红色危险态。全部纯 CSS 过渡，零 JS 动画。
 */
export const SidebarUserPanel = React.memo(function SidebarUserPanel({
  user,
  pinned,
  onClose,
  onPinToggle,
  onLogout,
}: SidebarUserPanelProps) {
  const roleLabel = getRoleLabel(user.roleType)
  const { unreadCount, refresh } = useServerNotifications()
  const [view, setView] = React.useState<'account' | 'notifications'>('account')
  const openNotifications = React.useCallback(() => {
    void refresh()
    setView('notifications')
  }, [refresh])
  const closeNotifications = React.useCallback(() => setView('account'), [])

  return (
    <section
      id="sidebar-user-panel"
      aria-label="账户子菜单"
      className="sidebar-panel-shell sidebar-panel-reveal relative z-20 flex h-screen w-[240px] shrink-0 flex-col border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header — 与 SidebarPanel 完全同款（56px，Pin + X） */}
      <div className="flex h-[56px] shrink-0 items-center justify-between border-b border-[hsl(var(--sidebar-border))]/60 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="h-7 w-7 shrink-0">
            <AvatarImage src={user.avatar} alt={user.name} />
            <AvatarFallback className="bg-[hsl(var(--sidebar-foreground)/0.06)] text-[0.78rem] font-medium tracking-tight text-sidebar-foreground/85">
              {user.name?.[0]?.toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-[0.95rem] font-semibold text-sidebar-foreground">
            账户
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPinToggle}
            aria-label={pinned ? '取消固定面板' : '固定面板'}
            title={pinned ? '取消固定' : '固定面板'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              pinned
                ? 'bg-primary/15 text-primary'
                : 'text-sidebar-foreground/50 hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground'
            )}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭面板"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — 身份卡 + 主题 + 操作 / 通知列表（BLF-603 视图切换） */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {view === 'notifications' ? (
          <NotificationListView onBack={closeNotifications} onNavigateClose={onClose} />
        ) : (
          <div className="flex flex-col gap-4">
            {/* 身份卡（BLF-608）：蓝→靛蓝渐变 wash + 右上角装饰辉光 + 环形方形头像，
                与 rail 底部 user chip 同一身份色语言；角色徽章用主色浅底 + 圆点。 */}
            <div className="relative overflow-hidden rounded-[0.85rem] border border-blue-200/60 bg-gradient-to-br from-blue-50/90 via-transparent to-indigo-100/60 p-3.5 dark:border-blue-800/30 dark:from-blue-950/40 dark:via-transparent dark:to-indigo-950/40">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-7 -top-9 h-24 w-24 rounded-full bg-blue-500/15 blur-2xl dark:bg-blue-400/15"
              />
              <div className="relative flex items-center gap-3">
                <Avatar className="h-14 w-14 shrink-0 rounded-[0.85rem] shadow-[0_2px_10px_rgba(59,130,246,0.16)] ring-2 ring-white/80 dark:ring-white/10">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-[0.85rem] bg-gradient-to-br from-blue-400 to-indigo-500 text-[1.05rem] font-semibold tracking-tight text-white dark:from-blue-500 dark:to-indigo-600">
                    {user.name?.[0]?.toUpperCase() ?? 'U'}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 text-left">
                  <span className="truncate text-[1.02rem] font-semibold tracking-tight text-sidebar-foreground">
                    {user.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  {roleLabel ? (
                    <span className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[0.65rem] font-semibold text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/15 dark:text-blue-300">
                      <span aria-hidden className="h-1 w-1 rounded-full bg-current opacity-70" />
                      {roleLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* 主题 */}
            <section aria-label="主题设置">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40">
                  主题
                </span>
                <span aria-hidden className="h-px flex-1 bg-[hsl(var(--sidebar-foreground)/0.08)]" />
              </div>
              <ThemeSwitcher />
            </section>

            {/* 账户操作 */}
            <section aria-label="账户操作">
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40">
                  账户
                </span>
                <span aria-hidden className="h-px flex-1 bg-[hsl(var(--sidebar-foreground)/0.08)]" />
              </div>
              <nav className="flex flex-col gap-0.5" aria-label="账户操作">
                {/* 通知入口（BLF-603）：原正文右上角浮动铃铛迁移至此 */}
                <button
                  type="button"
                  onClick={openNotifications}
                  aria-label={`通知${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
                  className="group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-left text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  <Bell className="h-4 w-4 shrink-0 text-sidebar-foreground/55 transition-colors group-hover/link:text-primary" />
                  <span className="min-w-0 flex-1 truncate">通知</span>
                  {unreadCount > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[0.65rem] font-semibold leading-none text-primary-foreground">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
                <RouteLoadingLink
                  href="/dashboard/profile"
                  onClick={onClose}
                  className="group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  <UserCog className="h-4 w-4 shrink-0 text-sidebar-foreground/55 transition-colors group-hover/link:text-primary" />
                  <span className="min-w-0 flex-1 truncate">个人资料</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/25 transition-all duration-200 group-hover/link:translate-x-0.5 group-hover/link:text-sidebar-foreground/50" />
                </RouteLoadingLink>
                <RouteLoadingLink
                  href="/dashboard/change-password"
                  onClick={onClose}
                  className="group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  <KeyRound className="h-4 w-4 shrink-0 text-sidebar-foreground/55 transition-colors group-hover/link:text-primary" />
                  <span className="min-w-0 flex-1 truncate">修改密码</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/25 transition-all duration-200 group-hover/link:translate-x-0.5 group-hover/link:text-sidebar-foreground/50" />
                </RouteLoadingLink>

                <div aria-hidden className="my-1 h-px bg-[hsl(var(--sidebar-foreground)/0.08)]" />

                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onLogout()
                  }}
                  className="group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-left text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-red-500/[0.06] hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/30"
                >
                  <LogOut className="h-4 w-4 shrink-0 text-red-500/60 transition-colors group-hover/link:text-red-500" />
                  <span className="min-w-0 flex-1 truncate">退出登录</span>
                </button>
              </nav>
            </section>
          </div>
        )}
      </div>
    </section>
  )
})

/**
 * 主题切换：3 按钮分段控件（浅色 / 深色 / 跟随系统），当前主题高亮。
 * BLF-608：升级为分段控件——容器内凹边框 + 当前段抬起（bg 面板色 + 轻阴影），
 * 视觉上更像一个完整的 control，而不是三个平铺按钮。
 */
function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  const currentTheme = mounted ? theme : 'system'

  const options = [
    { value: 'light' as const, label: '浅色', icon: SunMedium },
    { value: 'dark' as const, label: '深色', icon: Moon },
    { value: 'system' as const, label: '系统', icon: Monitor },
  ]

  return (
    <fieldset
      className="m-0 grid grid-cols-3 gap-0.5 rounded-[0.7rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.04)] p-0.5"
      aria-label="主题切换"
    >
      {options.map(({ value, label, icon: Icon }) => {
        const active = currentTheme === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={cn(
              'flex h-9 flex-col items-center justify-center gap-0.5 rounded-[0.55rem] text-[0.7rem] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
              active
                ? 'bg-[hsl(var(--sidebar-background))] text-sidebar-foreground shadow-[0_1px_2px_rgba(2,6,16,0.08)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.45)]'
                : 'text-sidebar-foreground/55 hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground/85'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="flex items-center gap-0.5">
              {label}
              {active ? <Check className="h-2.5 w-2.5 text-primary" /> : null}
            </span>
          </button>
        )
      })}
    </fieldset>
  )
}
