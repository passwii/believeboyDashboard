'use client'

import { useState, useRef, useEffect } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Plus,
  Lightbulb,
  Paperclip,
  Image,
  FileCode,
  SendHorizontal,
} from 'lucide-react'
import { ModelSelector } from './model-selector'

export function ChatInput({
  onSend,
  placeholder = '你想构建什么？',
  compact = false,
  disabled = false,
}: {
  onSend?: (message: string) => void
  placeholder?: string
  compact?: boolean
  disabled?: boolean
}) {
  const [message, setMessage] = useState('')
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const outerGlowRef = useRef<HTMLDivElement>(null)
  const sendBtnRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(
        textarea.scrollHeight,
        compact ? 120 : 200
      )}px`
    }
  }, [message, compact])

  // ── GSAP: Input glow on focus ───────────────────────────────────
  useGSAP(
    () => {
      if (outerGlowRef.current) {
        gsap.to(outerGlowRef.current, {
          opacity: focused ? 1 : 0,
          scale: focused ? 1 : 0.95,
          duration: 0.3,
          ease: 'power2.out',
        })
      }
    },
    { scope: rootRef, dependencies: [focused] }
  )

  const handleSubmit = () => {
    if (message.trim() && !disabled) {
      // Send button press animation
      if (sendBtnRef.current) {
        gsap.fromTo(
          sendBtnRef.current,
          { scale: 0.9 },
          { scale: 1, duration: 0.4, ease: 'back.out(3)' }
        )
      }
      onSend?.(message)
      setMessage('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div ref={rootRef} className="relative w-full max-w-[680px] mx-auto">
      {/* Outer glow */}
      <div
        ref={outerGlowRef}
        className="absolute -inset-2 rounded-3xl pointer-events-none"
        style={{ opacity: 0, transform: 'scale(0.95)' }}
        style={{
          opacity: focused ? (outerGlowRef.current ? undefined : 1) : 0,
          transform: focused ? undefined : 'scale(0.95)',
          boxShadow: '0 0 40px rgba(20,136,252,0.35), 0 0 80px rgba(20,136,252,0.15), 0 0 120px rgba(99,102,241,0.1)',
        }}
      />

      {/* Rotating gradient border */}
      <div className="relative rounded-2xl">
        <div
          className={`absolute -inset-[2px] rounded-2xl overflow-hidden pointer-events-none transition-opacity duration-500 ${
            focused ? 'opacity-100' : 'opacity-30'
          }`}
        >
          <div
            className="absolute inset-[-50%] bb-border-rotate"
            style={{
              background: focused
                ? 'conic-gradient(from 0deg, #1488fc, #6366f1, #8b5cf6, #1488fc, #38bdf8, #1488fc)'
                : 'conic-gradient(from 0deg, rgba(20,136,252,0.4), rgba(99,102,241,0.3), rgba(139,92,246,0.3), rgba(20,136,252,0.4))',
            }}
          />
        </div>

        {/* Inner surface */}
        <div
          className={`relative rounded-2xl transition-shadow duration-500 ${
            focused
              ? 'shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_30px_rgba(20,136,252,0.2)]'
              : 'shadow-[0_2px_20px_rgba(0,0,0,0.4)]'
          }`}
          style={{ background: '#1e1e22' }}
        >
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={placeholder}
              disabled={disabled}
              className={`w-full resize-none bg-transparent text-[15px] text-white placeholder-[#5a5a5f] px-4 sm:px-5 focus:outline-none ${
                compact
                  ? 'pt-3 pb-2 min-h-[44px] max-h-[120px]'
                  : 'pt-4 sm:pt-5 pb-3 min-h-[60px] sm:min-h-[80px] max-h-[200px]'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>

          <div
            className={`flex items-center justify-between px-3 sm:px-3 pt-1 ${
              compact ? 'pb-2' : 'pb-3'
            }`}
          >
            {/* Left actions */}
            <div className="flex items-center gap-1 sm:gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (disabled) return
                    gsap.fromTo(
                      document.querySelector('.attach-btn'),
                      { scale: 0.85 },
                      { scale: 1, duration: 0.25, ease: 'back.out(2)' }
                    )
                    setShowAttachMenu(!showAttachMenu)
                  }}
                  disabled={disabled}
                  className={`attach-btn flex items-center justify-center size-9 sm:size-10 rounded-full transition-all duration-300 active:scale-95 touch-manipulation ${
                    focused
                      ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
                      : 'bg-white/[0.08] text-[#8a8a8f] hover:bg-white/[0.12] hover:text-white'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  aria-label="添加附件"
                >
                  <Plus
                    className={`size-4 sm:size-5 transition-transform duration-200 ${
                      showAttachMenu ? 'rotate-45' : ''
                    }`}
                  />
                </button>
                {showAttachMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowAttachMenu(false)}
                    />
                    <div
                      className="absolute bottom-full left-0 mb-2 z-50 bg-[#1a1a1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
                      ref={(el) => {
                        if (el) gsap.fromTo(el, { opacity: 0, scale: 0.92, y: 8 }, { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(1.7)' })
                      }}
                    >
                      <div className="p-1.5 min-w-[160px] sm:min-w-[180px]">
                        {[
                          { icon: <Paperclip className="size-4" />, label: '上传文件' },
                          { icon: <Image className="size-4" />, label: '添加图片' },
                          { icon: <FileCode className="size-4" />, label: '导入代码' },
                        ].map((item, i) => (
                          <button
                            type="button"
                            key={i}
                            className="w-full flex items-center gap-3 px-3 py-2.5 sm:py-2 rounded-lg text-[#a0a0a5] hover:bg-white/5 hover:text-white transition-all duration-150 touch-manipulation"
                          >
                            {item.icon}
                            <span className="text-sm">{item.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <ModelSelector />
            </div>

            <div className="flex-1" />

            {/* Right actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                className={`flex items-center justify-center size-9 sm:size-10 rounded-full transition-all duration-300 touch-manipulation ${
                  focused
                    ? 'text-blue-400/80 hover:text-blue-300 hover:bg-blue-500/10'
                    : 'text-[#6a6a6f] hover:text-white hover:bg-white/5'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                aria-label="规划模式"
              >
                <Lightbulb className="size-4 sm:size-5" />
              </button>

              <button
                ref={sendBtnRef}
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || disabled}
                className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-2 rounded-full text-sm font-medium text-white transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 touch-manipulation ${
                  focused
                    ? 'bg-[#1a94ff] shadow-[0_0_25px_rgba(20,136,252,0.5),0_0_50px_rgba(20,136,252,0.2)]'
                    : 'bg-[#1488fc] shadow-[0_0_20px_rgba(20,136,252,0.3)] hover:bg-[#1a94ff] hover:shadow-[0_0_30px_rgba(20,136,252,0.45)]'
                }`}
                aria-label="发送"
              >
                <span className="hidden sm:inline">立即构建</span>
                <SendHorizontal className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
