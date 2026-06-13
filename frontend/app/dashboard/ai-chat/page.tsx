'use client'

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
 */
export default function DashboardAiChatPage() {
  return (
    <div className="absolute inset-0 -m-1 -mt-3 -mb-6 md:-m-2 md:-mt-3 md:-mb-8 lg:-m-3 xl:-m-4">
      <AIChatWindow />
    </div>
  )
}
