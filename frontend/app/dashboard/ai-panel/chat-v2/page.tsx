'use client'

import { BoltStyleChat } from '@/components/ui/bolt-style-chat'

export default function ChatV2Page() {
  return (
    <BoltStyleChat
      onSend={(message) => {
        // TODO: 接入后端 AI 接口
        console.log('User message:', message)
      }}
    />
  )
}
