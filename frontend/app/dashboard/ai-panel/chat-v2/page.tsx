'use client'

import { useEffect } from 'react'
import { animationStyles } from '@/components/chat/constants/animation-styles'
import { RayBackground } from '@/components/chat/components/ray-background'
import { FloatingParticles } from '@/components/chat/components/floating-particles'
import { AnnouncementBadge } from '@/components/chat/components/announcement-badge'
import { TypewriterText } from '@/components/chat/components/typewriter-text'

export default function ChatV2Page() {
  // Auto-open standalone AI chat in a new tab
  useEffect(() => {
    window.open('/ai-chat', '_blank')
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0f0f0f]">
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      {/* Layer 1: Glow Background */}
      <div className="absolute inset-0">
        <RayBackground />
        <FloatingParticles />
      </div>

      {/* Layer 2: Landing Content — no input box */}
      <div className="absolute inset-0 flex flex-col items-center">
        {/* Badge */}
        <div className="absolute top-[70px]">
          <AnnouncementBadge text="BelieveBoy AI 助手" />
        </div>

        {/* Title + Subtitle */}
        <div className="absolute top-[42%] left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-full px-4">
          <div className="text-center mb-6">
            <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-tight mb-3 min-h-[1.2em]">
              <TypewriterText
                segments={[
                  { text: '今天你想 ', speed: 80 },
                  { text: '构建', highlight: true, speed: 100 },
                  { text: ' 什么？', speed: 80 },
                ]}
                startDelay={800}
              />
            </h1>
            <p
              className="text-base font-semibold sm:text-lg text-[#8a8a8f] bb-anim-fade-up"
              style={{ animationDelay: '3s' }}
            >
              AI 聊天已在新窗口打开
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
