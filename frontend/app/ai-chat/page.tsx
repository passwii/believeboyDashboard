'use client'

import { BoltStyleChat } from '@/components/chat/bolt-style-chat'

export default function AiChatPage() {
  return (
    <BoltStyleChat
      onSend={(message) => {
        // TODO: 接入后端 AI 接口
        console.log('User message:', message)
      }}
    />
  )
}
