'use client'

import { AIChatWindow } from '@/components/chat/ai-chat-window'

export default function AiChatPage() {
  return (
    <AIChatWindow
      onSend={(message) => {
        // TODO: 接入后端 AI 接口
        console.log('User message:', message)
      }}
    />
  )
}
