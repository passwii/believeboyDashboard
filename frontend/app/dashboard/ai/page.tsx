'use client'

import { AIChatWindow } from '@/components/chat/ai-chat-window'
import styles from '@/components/chat/warm-chat.module.css'
import { MessageSquare } from 'lucide-react'
import Link from 'next/link'

export default function AiLandingPage() {
  return (
    <main
      className={`${styles.page} warm-ledger relative h-screen w-full supports-[height:100dvh]:h-dvh md:h-full`}
      data-testid="ai-landing-warm-page"
      data-warm-surface="warm-ledger"
    >
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
          href="/dashboard/ai/chat"
          className={styles.entry}
        >
          <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>进入 AI Chat</span>
        </Link>
      </div>
    </main>
  )
}
