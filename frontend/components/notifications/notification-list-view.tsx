'use client'

import { ArrowLeft, CheckCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { ServerNotification } from '@/lib/notifications-api'
import { useServerNotifications } from './server-notifications-context'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

function NotificationRow({
  n,
  onOpen,
}: {
  n: ServerNotification
  onOpen: (n: ServerNotification) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={`flex w-full items-start gap-2 rounded-none border border-transparent px-3 py-2.5 text-left transition-colors hover:border-term-border hover:bg-term-hover ${
        n.read ? 'opacity-70' : 'border-term-accent/30 bg-term-accent/5'
      }`}
    >
      {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-term-accent" />}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs leading-5 text-term-text">{n.title}</div>
        {n.message && (
          <div className="truncate font-mono text-[11px] leading-4 text-term-muted">
            {n.message}
          </div>
        )}
        <div className="mt-0.5 font-mono text-[11px] leading-4 text-term-faint">
          {timeAgo(n.created_at)}
        </div>
      </div>
    </button>
  )
}

interface NotificationListViewProps {
  /**
   * 返回上一视图（桌面端返回账户视图；移动端返回导航分组）。
   */
  onBack: () => void
  /**
   * 点击通知跳转后关闭所在 surface（桌面端关面板 / 移动端关 Sheet）。
   */
  onNavigateClose: () => void
}

/**
 * 内嵌式通知列表（BLF-603）。
 *
 * 原 NotificationBell 使用悬浮 Popover（Radix portal 渲染到 body），在 sidebar 的
 * hover 状态机下不可用：鼠标从面板内的触发行移入弹层会触发面板 wrapper 的
 * mouseleave → 150ms 后面板关闭 → 弹层随组件卸载一并消失。
 *
 * 本组件改为在宿主容器（SidebarUserPanel / 移动端 Sheet）内部直接渲染列表，
 * 交互全程留在宿主容器内，绕开 portal / mouseleave 冲突。打开时调用方负责
 * 触发 refresh() 拉取最新列表。
 */
export function NotificationListView({ onBack, onNavigateClose }: NotificationListViewProps) {
  const router = useRouter()
  const { unreadCount, items, loading, markRead, markAllRead } = useServerNotifications()

  const handleOpen = (n: ServerNotification) => {
    if (!n.read) void markRead(n.id)
    const link = n.data?.link
    onNavigateClose()
    if (link) router.push(link)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — 返回 + 标题 + 全部已读 */}
      <div className="flex items-center gap-1 border-b border-term-border pb-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          // BLF-893：去掉已不存在的 --sidebar-foreground 令牌（旧侧栏遗产），
          // 改走 term-* 令牌；hover/focus 用 term-hover + term-border-strong。
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-none text-term-muted transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:border-term-border-strong"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs uppercase tracking-wider text-term-muted">
          通知
        </span>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={unreadCount === 0}
          className="flex h-8 shrink-0 items-center gap-1 rounded-none px-2 font-mono text-[11px] leading-4 text-term-muted transition-colors hover:bg-term-hover hover:text-term-text disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:border-term-border-strong"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          全部已读
        </button>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {loading ? (
          <div className="py-8 text-center font-mono text-xs leading-5 text-term-muted">
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center font-mono text-xs leading-5 text-term-muted">
            暂无通知
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} onOpen={handleOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
