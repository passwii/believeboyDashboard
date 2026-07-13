'use client'

import { AIChatWindow } from '@/components/chat/ai-chat-window'
import { MessageSquare } from 'lucide-react'
import Link from 'next/link'

export default function AiLandingPage() {
  return (
    <div className="relative h-full w-full">
      <AIChatWindow
        title="让 AI"
        titleHighlight="助你"
        subtitle="探索智能助手，提升运营效率"
        announcementText="BelieveBoy AI 助手"
        showInput={false}
      />

      {/* 底部跳转入口 - 当动画播放完后显示 */}
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50">
        <Link
          href="/dashboard/ai-chat"
          className="flex items-center gap-2 px-6 py-3 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm font-medium hover:bg-white/20 transition-all duration-300 hover:scale-105"
        >
          <MessageSquare className="size-4" />
          <span>进入 AI Chat</span>
        </Link>
      </div>
    </div>
  )
}
