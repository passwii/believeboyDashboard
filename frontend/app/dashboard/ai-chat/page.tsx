'use client'

import { AIChatWindow } from '@/components/chat/ai-chat-window'

/**
 * Dashboard 内嵌版 AI Chat。
 * 继承 dashboard/layout.tsx，自动获得 sidebar + header。
 * 容器高度扣除 header (4.5rem)，让 AIChatWindow 的 h-full 能完整占满。
 *
 * AIChatWindow 现在自管所有 backend 调用（load / send / regenerate /
 * rename / delete），所以这里不再需要 `onSend` 钩子。
 */
export default function DashboardAiChatPage() {
  return (
    <div className="-mx-1 -mb-6 h-[calc(100dvh-4.5rem)] md:-mx-2 md:-mb-8 lg:-mx-3 xl:-mx-4">
      <AIChatWindow />
    </div>
  )
}
