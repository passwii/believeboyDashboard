'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Moon, SunMedium } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TERMINAL_RAIL_WIDTH, TERMINAL_TOP_STRIP_HEIGHT, TERMINAL_RAIL_ICON_SIZE } from '@/components/terminal/terminal-constants'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface TerminalRailProps {
  groups: SidebarTopGroup[]
  activeGroupId?: string
  /** 点击域图标：切到该分类第一个模块 */
  onGroupNavigate: (group: SidebarTopGroup) => void
}

/**
 * L1 极窄主轨（固定 64px，BLF-809；BLF-887 图标 20→24 上档 2026-08-29）：9 大业务域图标 + 底部主题切换与用户菜单。
 * 仅图标不落文字，hover 以 title 提示；活动域以左侧 2px accent 指示。
 * 图标尺寸经内联 style 应用（Tailwind JIT 不编译模板字符串拼出的类，动态 `h-[${N}px]` 从未生成）。
 */
export function TerminalRail({ groups, activeGroupId, onGroupNavigate }: TerminalRailProps) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <aside
      style={{ width: TERMINAL_RAIL_WIDTH }}
      className="hidden h-full shrink-0 flex-col rounded-none border-r border-term-border bg-term-panel shadow-none md:flex"
    >
      {/* Logo 位：高度引用顶部基准带常量（BLF-832），与 Header / SubNav / Inspector 顶部分割线贯通 */}
      <div
        style={{ height: TERMINAL_TOP_STRIP_HEIGHT }}
        className="flex shrink-0 items-center justify-center border-b border-term-border"
      >
        <button
          type="button"
          onClick={() => router.push('/dashboard')}
          aria-label="返回总览"
          className="flex h-10 w-10 items-center justify-center rounded-none bg-term-accent font-mono text-base font-bold text-white shadow-none transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          B
        </button>
      </div>

      {/* 9 大业务域图标 */}
      <nav id="main-navigation" className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2 term-scroll">
        {groups.map((group) => {
          const Icon = group.icon
          const isActive = group.id === activeGroupId
          return (
            <button
              key={group.id}
              type="button"
              title={group.label}
              aria-label={group.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onGroupNavigate(group)}
              className={cn(
                'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-none shadow-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent',
                isActive
                  ? 'bg-term-hover text-term-text'
                  : 'text-term-muted hover:bg-term-hover hover:text-term-text'
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 bg-term-accent" />
              )}
              <Icon className="shrink-0" style={{ height: TERMINAL_RAIL_ICON_SIZE, width: TERMINAL_RAIL_ICON_SIZE }} strokeWidth={1.75} />
            </button>
          )
        })}
      </nav>

      {/* 底部：主题切换 + 用户菜单 */}
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-term-border py-2">
        <button
          type="button"
          title={isDark ? '切换亮色' : '切换暗色'}
          aria-label="切换主题"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className="flex h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          {isDark ? <SunMedium className="shrink-0" style={{ height: TERMINAL_RAIL_ICON_SIZE, width: TERMINAL_RAIL_ICON_SIZE }} /> : <Moon className="shrink-0" style={{ height: TERMINAL_RAIL_ICON_SIZE, width: TERMINAL_RAIL_ICON_SIZE }} />}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="用户" aria-label="用户菜单" data-testid="terminal-user-trigger" className="flex h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent">
              <span className="flex h-7 w-7 items-center justify-center rounded-sm border border-term-border-strong bg-term-raised font-mono text-xs uppercase text-term-text">
                U
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="min-w-36 rounded-none border-term-border bg-term-panel text-term-text">
            <DropdownMenuLabel className="text-xs text-term-muted">系统</DropdownMenuLabel>
            <DropdownMenuItem
              className="rounded-none text-xs focus:bg-term-hover focus:text-term-text"
              onClick={() => router.push('/dashboard/profile')}
            >
              个人中心
            </DropdownMenuItem>
            <DropdownMenuItem
              className="rounded-none text-xs focus:bg-term-hover focus:text-term-text"
              onClick={() => router.push('/dashboard/change-password')}
            >
              修改密码
            </DropdownMenuItem>
            <DropdownMenuItem
              className="rounded-none text-xs focus:bg-term-hover focus:text-term-text"
              onClick={() => router.push('/dashboard/feature-updates')}
            >
              产品更新
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-term-border" />
            <DropdownMenuItem
              className="rounded-none text-xs focus:bg-term-hover focus:text-term-text"
              onClick={() => window.dispatchEvent(new CustomEvent('believeboy:logout'))}
            >
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
