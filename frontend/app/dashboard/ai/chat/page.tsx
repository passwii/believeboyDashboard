'use client'

import { useEffect } from 'react'
import { AIChatWindow } from '@/components/chat/ai-chat-window'

/**
 * Dashboard 内嵌版 AI Chat。
 * 继承 dashboard/layout.tsx，自动获得 sidebar + header。
 *
 * 用 `absolute inset-0` + 负 margin 抵消 main 容器（`px-1 pt-3 pb-6` /
 * `px-2 pb-8` / `px-3` / `px-4` 四档 padding）的内边距，让 AIChatWindow
 * 的 `h-full` 真正占满 100dvh 视口高度。不能让任何 dashboard 背景色
 * 透过顶 / 底透出。
 *
 * AIChatWindow 现在自管所有 backend 调用（load / send / regenerate /
 * rename / delete），所以这里不再需要 `onSend` 钩子。
 *
 * 强制 dark：AIChatWindow 内部写死暗色（bg-[#0f0f0f] / text-white 等），
 * 不依赖系统主题。dashboard 父布局的 `bg-[hsl(var(--surface-low))]` 和
 * SidebarShell 的 shadcn 主题 token 由 `<html class="dark">` 驱动 ——
 * 通过 next-themes 的 `useTheme` 在 mount/unmount 临时切换，保证只在这
 * 一个页面进入暗色，离开时还原用户原选择，不污染其他页面。
 *
 * `!absolute` 用意：`globals.css` 里有规则
 *   `.dark .dashboard-page-shell > * { position: relative; z-index: 1; }`
 * 它的本意是让 dashboard 页面的内容浮在 `dashboard-page-shell::before`
 * 的渐变背景之上，但在 ai-chat 这里会把根 div 的 `absolute` 强制覆盖成
 * `relative`，导致 inset-0 失效、根 div 塌缩、整页看不到。`!important`
 * 把 absolute 抬到这个 base 规则之上，保证 dark 模式下 chat 窗口依然
 * 撑满视口。
 */
export default function DashboardAiChatPage() {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const hadDark = root.classList.contains('dark')
    if (!hadDark) root.classList.add('dark')
    return () => {
      // 只在本次进入是"我们强制加的"时才在卸载时移除，避免覆盖用户
      // 在本页手动切换的最终状态。
      if (!hadDark) root.classList.remove('dark')
    }
  }, [])

  return (
    <div className="!absolute inset-0 -m-1 -mt-3 -mb-6 md:-m-2 md:-mt-3 md:-mb-8 lg:-m-3 xl:-m-4">
      <AIChatWindow />
    </div>
  )
}
