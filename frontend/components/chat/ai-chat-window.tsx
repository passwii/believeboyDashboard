'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { PanelLeft, Square } from 'lucide-react'

import { animationStyles } from './constants/animation-styles'
import { useSimulatedStream } from './hooks/use-simulated-stream'
import { TypewriterText } from './typewriter-text'
import { ChatInput } from './chat-input'
import { RayBackground } from './ray-background'
import { AnnouncementBadge } from './announcement-badge'
import { FloatingParticles } from './floating-particles'
import { ChatMessageList } from './chat-message-list'
import { ConversationSidebar } from './conversation-sidebar'

import type {
  TextSegment,
  ChatMessage,
  Phase,
  AIChatWindowProps,
  Conversation,
} from './types'

export function AIChatWindow({
  title = '今天你想',
  titleHighlight = '构建',
  subtitle = '从今天出发，用 AI Agent 创造新高度',
  announcementText = 'BelieveBoy AI 助手',
  announcementHref = '#',
  placeholder = '你想构建什么？',
  showInput = true,
  onSend,
}: AIChatWindowProps) {
  const [phase, setPhase] = useState<Phase>('landing')
  const [arcsUp, setArcsUp] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: 'conv-1',
      title: '新对话',
      createdAt: Date.now(),
      messageCount: 0,
    },
  ])
  const [activeConvId, setActiveConvId] = useState<string | null>('conv-1')

  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const stopBtnRef = useRef<HTMLButtonElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const streamStoppedRef = useRef(false)
  const stopBtnShownRef = useRef(false)

  const isLanding = phase === 'landing'
  const isChat = phase === 'chat'
  const hasMessages = messages.length > 0

  // ── GSAP: Sidebar entrance ──────────────────────────────────────
  useGSAP(
    () => {
      if (sidebarRef.current) {
        gsap.fromTo(
          sidebarRef.current,
          { opacity: 0, x: -280 },
          {
            opacity: 1,
            x: 0,
            duration: 0.35,
            ease: 'power3.out',
          }
        )
      }
    },
    { scope: sidebarRef, dependencies: [showSidebar] }
  )

  // ── GSAP: Stop button ────────────────────────────────────────────
  useGSAP(
    () => {
      if (!stopBtnRef.current) return
      if (isStreaming && !stopBtnShownRef.current) {
        stopBtnShownRef.current = true
        gsap.fromTo(
          stopBtnRef.current,
          { opacity: 0, scale: 0.8, y: 8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(2)' }
        )
      } else if (!isStreaming && stopBtnShownRef.current) {
        stopBtnShownRef.current = false
        gsap.to(stopBtnRef.current, {
          opacity: 0,
          scale: 0.9,
          y: -8,
          duration: 0.2,
          ease: 'power2.in',
        })
      }
    },
    { scope: rootRef, dependencies: [isStreaming] }
  )

  // ── Auto-scroll ──────────────────────────────────────────────────
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [messages])

  // ── Stream callbacks ─────────────────────────────────────────────
  const handleStreamChunk = useCallback((delta: string) => {
    if (streamStoppedRef.current) return
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [
        ...prev.slice(0, -1),
        { ...last, content: last.content + delta, streaming: true },
      ]
    })
  }, [])

  const handleStreamDone = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
    setIsStreaming(false)
    streamStoppedRef.current = false
  }, [])

  const { start: startStream, stop: stopStream } = useSimulatedStream(
    handleStreamChunk,
    handleStreamDone
  )

  const handleStopGeneration = useCallback(() => {
    streamStoppedRef.current = true
    stopStream()
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
    setIsStreaming(false)
  }, [stopStream])

  // ── Conversation management ───────────────────────────────────────
  const handleCreateConversation = useCallback(() => {
    const newConv: Conversation = {
      id: `conv-${Date.now()}`,
      title: '新对话',
      createdAt: Date.now(),
      messageCount: 0,
    }
    setConversations((prev) => [newConv, ...prev])
    setActiveConvId(newConv.id)
    setMessages([])
    setPhase('chat')
    setShowSidebar(false)
  }, [])

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id)
    setMessages([])
    setPhase('chat')
    setShowSidebar(false)
  }, [])

  const handleRenameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    )
  }, [])

  const handleDeleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id)
        if (filtered.length === 0) {
          const newConv: Conversation = {
            id: `conv-${Date.now()}`,
            title: '新对话',
            createdAt: Date.now(),
            messageCount: 0,
          }
          setActiveConvId(newConv.id)
          return [newConv]
        }
        if (activeConvId === id) {
          setActiveConvId(filtered[0].id)
        }
        return filtered
      })
    },
    [activeConvId]
  )

  // ── Message operations ─────────────────────────────────────────────
  const handleRegenerateMessage = useCallback(
    (messageId: string) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        const newMessages = prev.slice(0, idx)
        const newAssistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        setIsStreaming(true)
        streamStoppedRef.current = false
        startStream()
        return [...newMessages, newAssistantMsg]
      })
    },
    [startStream]
  )

  const handleEditMessage = useCallback((messageId: string) => {
    // TODO: full edit mode
  }, [])

  const handleDeleteMessage = useCallback((messageId: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId)
      if (idx === -1) return prev
      const nextMsg = prev[idx + 1]
      if (nextMsg && nextMsg.role === 'assistant') {
        return [...prev.slice(0, idx), ...prev.slice(idx + 2)]
      }
      return prev.filter((m) => m.id !== messageId)
    })
  }, [])

  // ── Send ──────────────────────────────────────────────────────────
  const handleSend = useCallback(
    (message: string) => {
      if (!showInput) return

      onSend?.(message)

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: message,
      }

      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConvId
            ? {
                ...c,
                messageCount: c.messageCount + 2,
                title:
                  c.messageCount === 0 ? message.slice(0, 30) : c.title,
              }
            : c
        )
      )

      if (phase === 'landing') {
        setPhase('transitioning')
        setArcsUp(true)

        setTimeout(() => {
          setPhase('chat')
          const assistantMsg: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: '',
            streaming: true,
          }
          setMessages([userMsg, assistantMsg])
          setIsStreaming(true)
          streamStoppedRef.current = false
          startStream()
        }, 800)
      } else {
        const assistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        setMessages((prev) => [...prev, userMsg, assistantMsg])
        setIsStreaming(true)
        streamStoppedRef.current = false
        startStream()
      }
    },
    [phase, onSend, startStream, showInput, activeConvId]
  )

  // ── Typewriter segments ──────────────────────────────────────────
  const typewriterSegments: TextSegment[] = [
    { text: `${title} `, speed: 80 },
    { text: titleHighlight, highlight: true, speed: 100 },
    { text: ' 什么？', speed: 80 },
  ]

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full overflow-hidden bg-[#0f0f0f] safe-area-inset-top safe-area-inset-bottom"
    >
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      {/* Layer 1: Background */}
      <div className="absolute inset-0">
        <RayBackground arcsUp={arcsUp} />
        <FloatingParticles />
      </div>

      {/* Layer 2: Sidebar */}
      {showSidebar && (
        <div ref={sidebarRef}>
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConvId}
            onSelect={handleSelectConversation}
            onCreate={handleCreateConversation}
            onRename={handleRenameConversation}
            onDelete={handleDeleteConversation}
            onClose={() => setShowSidebar(false)}
          />
        </div>
      )}

      {/* Layer 3: Landing */}
      <div
        className="absolute inset-0 flex flex-col items-center transition-opacity duration-300"
        style={{
          opacity: isLanding ? 1 : 0,
          pointerEvents: isLanding ? 'auto' : 'none',
        }}
      >
        <div className="absolute top-[60px] sm:top-[70px]">
          <AnnouncementBadge
            text={announcementText}
            href={announcementHref}
          />
        </div>

        <div className="absolute left-1/2 top-[32%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-full px-6 sm:px-4">
          <div className="text-center mb-4 sm:mb-6">
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight mb-3 min-h-[1.2em]">
              <TypewriterText
                segments={typewriterSegments}
                startDelay={800}
              />
            </h1>
            <p
              className="text-sm sm:text-base md:text-lg font-semibold text-[#8a8a8f] bb-anim-fade-up"
              style={{ animationDelay: '3s' }}
            >
              {subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Layer 4: Chat messages */}
      {hasMessages && (
        <div
          ref={chatScrollRef}
          className={`absolute inset-0 overflow-y-auto overscroll-contain ${
            isChat ? 'bb-chat-enter' : 'opacity-0'
          }`}
          style={{
            paddingTop: 'env(safe-area-inset-top, 16px)',
            paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 16px))',
          }}
        >
          <div className="px-3 sm:px-4 pt-6 pb-4">
            {/* Sidebar toggle */}
            <div className="fixed top-4 left-4 z-20">
              <button
                type="button"
                onClick={() => setShowSidebar(!showSidebar)}
                className="flex items-center justify-center size-9 rounded-xl bg-white/[0.06] border border-white/[0.08] text-[#8a8a8f] hover:text-white hover:bg-white/[0.1] transition-all duration-200 active:scale-95"
                aria-label={showSidebar ? '关闭侧边栏' : '打开侧边栏'}
              >
                <PanelLeft className="size-4" />
              </button>
            </div>

            <ChatMessageList
              messages={messages}
              onRegenerate={handleRegenerateMessage}
              onEdit={handleEditMessage}
              onDelete={handleDeleteMessage}
            />
          </div>
        </div>
      )}

      {/* Layer 5: Input */}
      {showInput && (
        <div
          className="absolute left-0 right-0 w-full px-3 sm:px-4"
          style={{
            ...(isLanding
              ? { top: '55%', transform: 'translateY(-50%)' }
              : {
                  bottom: '0',
                  paddingBottom: 'env(safe-area-inset-bottom, 16px)',
                }),
            transition:
              'top 0.7s cubic-bezier(0.22, 1, 0.36, 1), bottom 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
            zIndex: 40,
          }}
        >
          <div className="relative w-full max-w-[680px] mx-auto">
            {/* Stop button */}
            <div
              className="absolute -top-14 left-1/2 -translate-x-1/2"
              style={{ opacity: 0 }}
            >
              <button
                ref={stopBtnRef}
                type="button"
                onClick={handleStopGeneration}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#8a8a8f] hover:text-white hover:bg-white/[0.1] transition-all duration-200 active:scale-95"
                style={{
                  animation:
                    isStreaming
                      ? 'bb-stop-pulse 1.5s ease-in-out infinite'
                      : 'none',
                }}
                aria-label="停止生成"
              >
                <Square className="size-3 fill-current" />
                <span className="text-xs font-medium">停止生成</span>
              </button>
            </div>

            <ChatInput
              placeholder={isLanding ? placeholder : '继续对话...'}
              onSend={handleSend}
              compact={!isLanding}
              disabled={isStreaming}
            />
          </div>
        </div>
      )}
    </div>
  )
}
