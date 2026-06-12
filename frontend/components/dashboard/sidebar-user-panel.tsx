'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import {
  Check,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Pin,
  PinOff,
  SunMedium,
  X,
} from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
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
  factory: '工厂',
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
 * 性能要点：
 * - React.memo + 默认浅比较：user / 回调引用稳定时，路由切换不会重渲染本组件。
 * - 不订阅 usePathname()：本面板内容（用户信息、主题、退出登录）与路由无关。
 */
export const SidebarUserPanel = React.memo(function SidebarUserPanel({
  user,
  pinned,
  onClose,
  onPinToggle,
  onLogout,
}: SidebarUserPanelProps) {
  const roleLabel = getRoleLabel(user.roleType)

  return (
    <div
      id='sidebar-user-panel'
      role='region'
      aria-label='账户子菜单'
      className='sidebar-panel-shell relative z-20 flex h-screen w-[240px] shrink-0 flex-col border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header — 与 SidebarPanel 完全同款（56px，Pin + X） */}
      <div className='flex h-[56px] shrink-0 items-center justify-between border-b border-[hsl(var(--sidebar-border))]/60 px-4'>
        <div className='flex min-w-0 items-center gap-2'>
          <Avatar className='h-7 w-7 shrink-0'>
            <AvatarImage src={user.avatar} alt={user.name} />
            <AvatarFallback className='bg-[hsl(var(--sidebar-foreground)/0.06)] text-[0.78rem] font-medium tracking-tight text-sidebar-foreground/85'>
              {user.name?.[0]?.toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
          <span className='truncate text-[0.95rem] font-semibold text-sidebar-foreground'>
            账户
          </span>
        </div>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={onPinToggle}
            aria-label={pinned ? '取消固定面板' : '固定面板'}
            title={pinned ? '取消固定' : '固定面板'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              pinned
                ? 'bg-primary/15 text-primary'
                : 'text-sidebar-foreground/50 hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground',
            )}
          >
            {pinned ? <PinOff className='h-3.5 w-3.5' /> : <Pin className='h-3.5 w-3.5' />}
          </button>
          <button
            type='button'
            onClick={onClose}
            aria-label='关闭面板'
            title='关闭'
            className='flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>

      {/* Body — 信息卡 + 主题 + 操作 */}
      <div className='flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3'>
        {/* 用户信息卡 */}
        <section className='flex items-center gap-3'>
          <Avatar className='h-14 w-14 rounded-md shrink-0'>
            <AvatarImage src={user.avatar} alt={user.name} />
            <AvatarFallback className='rounded-md bg-[hsl(var(--sidebar-foreground)/0.06)] text-[1.05rem] font-medium tracking-tight text-sidebar-foreground/85'>
              {user.name?.[0]?.toUpperCase() ?? 'U'}
            </AvatarFallback>
          </Avatar>
          <div className='grid flex-1 min-w-0 text-left text-sm leading-tight'>
            <span className='truncate text-base font-semibold text-sidebar-foreground'>
              {user.name}
            </span>
            <span className='truncate text-xs text-muted-foreground'>{user.email}</span>
            {roleLabel ? (
              <span className='mt-1 inline-flex w-fit items-center rounded-full border border-sidebar-foreground/10 bg-sidebar-foreground/[0.04] px-1.5 py-0.5 text-[0.65rem] font-medium text-sidebar-foreground/70'>
                {roleLabel}
              </span>
            ) : null}
          </div>
        </section>

        <div className='border-t border-[hsl(var(--sidebar-border))]/60' />

        {/* 主题切换 */}
        <section>
          <div className='mb-2 flex items-center justify-between px-1'>
            <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
              主题
            </span>
          </div>
          <ThemeSwitcher />
        </section>

        <div className='border-t border-[hsl(var(--sidebar-border))]/60' />

        {/* 账户操作 */}
        <section>
          <div className='mb-2 flex items-center justify-between px-1'>
            <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
              账户
            </span>
          </div>
          <nav className='flex flex-col gap-0.5' aria-label='账户操作'>
            <RouteLoadingLink
              href='/dashboard/change-password'
              onClick={onClose}
              className='group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30'
            >
              <KeyRound className='h-4 w-4 shrink-0 text-primary' />
              <span className='min-w-0 flex-1 truncate'>修改密码</span>
            </RouteLoadingLink>
            <button
              type='button'
              onClick={() => {
                onClose()
                onLogout()
              }}
              className='group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-left text-[0.88rem] font-medium text-sidebar-foreground/72 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30'
            >
              <LogOut className='h-4 w-4 shrink-0 text-primary' />
              <span className='min-w-0 flex-1 truncate'>退出登录</span>
            </button>
          </nav>
        </section>
      </div>
    </div>
  )
})

/**
 * 主题切换：3 按钮并排（浅色 / 深色 / 跟随系统），当前主题高亮。
 * 高度 10 与 SidebarPanel 的 sub items 同款（h-10），视觉对齐。
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
    <div className='grid grid-cols-3 gap-1' role='group' aria-label='主题切换'>
      {options.map(({ value, label, icon: Icon }) => {
        const active = currentTheme === value
        return (
          <button
            key={value}
            type='button'
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={cn(
              'flex h-10 flex-col items-center justify-center gap-0.5 rounded-[0.6rem] text-[0.72rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
              active
                ? 'bg-[hsl(var(--sidebar-foreground)/0.08)] text-sidebar-foreground'
                : 'text-sidebar-foreground/55 hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground/85',
            )}
          >
            <Icon className='h-3.5 w-3.5' />
            <span className='flex items-center gap-0.5'>
              {label}
              {active ? <Check className='h-2.5 w-2.5 text-primary' /> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}