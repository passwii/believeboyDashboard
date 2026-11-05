'use client'

import { AIChatWindow } from '@/components/chat/ai-chat-window'
import styles from '@/components/chat/warm-chat.module.css'

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
 * 主题：不再强制 `html.dark`。AIChatWindow 内部已通过 `dark:` 变体同时
 * 支持浅色与深色，跟随 next-themes 的 `resolvedTheme`（`html.dark`
 * 是否存在）自动切换。保留 `!absolute` 以覆盖 `globals.css` 中
 * `.dark .dashboard-page-shell > * { position: relative }` 的抬层规则，
 * 保证两种主题下 chat 窗口都能撑满视口。
 */
export default function DashboardAiChatPage() {
  return (
    <main
      className={`${styles.fullscreenPage} warm-ledger relative -m-1 -mt-5 -mb-6 h-screen supports-[height:100dvh]:h-dvh md:!absolute md:inset-0 md:h-auto md:-m-2 md:-mt-3 md:-mb-8 lg:-m-3 xl:-m-4`}
      data-testid="ai-chat-fullscreen-page"
      data-warm-surface="warm-ledger"
    >
      <AIChatWindow />
    </main>
  )
}
