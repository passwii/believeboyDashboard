'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { animationStyles } from './constants/animation-styles'
import { useSimulatedStream } from './hooks/use-simulated-stream'
import { TypewriterText } from './components/typewriter-text'
import { ChatInput } from './components/chat-input'
import { RayBackground } from './components/ray-background'
import { AnnouncementBadge } from './components/announcement-badge'
import { FloatingParticles } from './components/floating-particles'
import { ChatMessageList } from './components/chat-message-list'
import type { TextSegment, ChatMessage, Phase, BoltChatProps } from './types'

export function BoltStyleChat({
  title = '今天你想',
  titleHighlight = '构建',
  subtitle = '从今天出发，用 AI Agent 创造新高度',
  announcementText = 'BelieveBoy AI 助手',
  announcementHref = '#',
  placeholder = '你想构建什么？',
  onSend,
}: BoltChatProps) {
  const [phase, setPhase] = useState<Phase>('landing')
  const [arcsUp, setArcsUp] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const chatScrollRef = useRef<HTMLDivElement>(null)

  const isLanding = phase === 'landing'
  const isChat = phase === 'chat'
  const hasMessages = messages.length > 0

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages])

  // Simulated stream callbacks
  const handleStreamChunk = useCallback((delta: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, content: last.content + delta, streaming: true }]
    })
  }, [])

  const handleStreamDone = useCallback(() => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
  }, [])

  const { start: startStream } = useSimulatedStream(handleStreamChunk, handleStreamDone)

  const handleSend = useCallback((message: string) => {
    onSend?.(message)

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
    }

    if (phase === 'landing') {
      // First send: trigger the full transition
      setPhase('transitioning')
      setArcsUp(true)

      // After dark surface reaches top + input slides down
      setTimeout(() => {
        setPhase('chat')
        const assistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        setMessages([userMsg, assistantMsg])
        startStream()
      }, 800)
    } else {
      // Subsequent sends: just add messages
      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        streaming: true,
      }
      setMessages(prev => [...prev, userMsg, assistantMsg])
      startStream()
    }
  }, [phase, onSend, startStream])

  const typewriterSegments: TextSegment[] = [
    { text: `${title} `, speed: 80 },
    { text: titleHighlight, highlight: true, speed: 100 },
    { text: ' 什么？', speed: 80 },
  ]

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0f0f0f]">
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      {/* Layer 1: Glow Background */}
      <div className="absolute inset-0">
        <RayBackground arcsUp={arcsUp} />
        <FloatingParticles />
      </div>

      {/* Layer 2: Landing Content */}
      <div
        className="absolute inset-0 flex flex-col items-center transition-opacity duration-300"
        style={{ opacity: isLanding ? 1 : 0, pointerEvents: isLanding ? 'auto' : 'none' }}
      >
        {/* Badge */}
        <div className="absolute top-[70px]">
          <AnnouncementBadge text={announcementText} href={announcementHref} />
        </div>

        {/* Title + Subtitle */}
        <div className="absolute top-[66%] left-1/2 sm:top-[42%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-full px-4">
          <div className="text-center mb-6">
            <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-tight mb-3 min-h-[1.2em]">
              <TypewriterText segments={typewriterSegments} startDelay={800} />
            </h1>
            <p
              className="text-base font-semibold sm:text-lg text-[#8a8a8f] bb-anim-fade-up"
              style={{ animationDelay: '3s' }}
            >
              {subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Layer 4: Chat Messages */}
      {hasMessages && (
        <div
          ref={chatScrollRef}
          className={`absolute inset-0 overflow-y-auto px-4 pt-6 pb-[100px] ${
            isChat ? 'bb-chat-enter' : 'opacity-0'
          }`}
        >
          <ChatMessageList messages={messages} />
        </div>
      )}

      {/* Layer 5: Input Box */}
      <div
        className="absolute left-1/2 w-full max-w-[700px] px-4"
        style={{
          transform: 'translateX(-50%)',
          ...(isLanding
            ? { top: '50%' }
            : { bottom: '24px' }
          ),
          transition: 'top 0.7s cubic-bezier(0.22, 1, 0.36, 1), bottom 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
          zIndex: 40,
        }}
      >
        <ChatInput
          placeholder={isLanding ? placeholder : '继续对话...'}
          onSend={handleSend}
          compact={!isLanding}
        />
      </div>
    </div>
  )
}
