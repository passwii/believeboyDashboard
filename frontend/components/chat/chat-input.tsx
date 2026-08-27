'use client'

import { useEffect, useState, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Plus,
  Paperclip,
  Image,
  FileCode,
  SendHorizontal,
  Globe,
  BrainCircuit,
  AlertCircle,
} from 'lucide-react'
import { ModelSelector } from './model-selector'
import {
  ensureConfigLoaded,
  getConfig,
  subscribe as subscribeConfig,
} from '@/lib/api/ai-chat-config-store'

export function ChatInput({
  onSend,
  placeholder = '你想构建什么？',
  compact = false,
  disabled = false,
  enableWebSearch = false,
  onToggleWebSearch,
  reasoningEffort,
  onReasoningEffortChange,
  selectedModel,
  onModelChange,
}: {
  onSend?: (
    message: string,
    options?: {
      reasoningEffort?: string | null
      enableWebSearch?: boolean
      model?: string
    }
  ) => void
  placeholder?: string
  compact?: boolean
  disabled?: boolean
  enableWebSearch?: boolean
  onToggleWebSearch?: (value: boolean) => void
  reasoningEffort?: string | null
  onReasoningEffortChange?: (value: string | null) => void
  selectedModel?: string
  onModelChange?: (modelId: string) => void
}) {
  const [message, setMessage] = useState('')
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [focused, setFocused] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const outerGlowRef = useRef<HTMLDivElement>(null)
  const sendBtnRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const webSearchBtnRef = useRef<HTMLButtonElement>(null)
  const webSearchRingRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    ensureConfigLoaded().catch(() => {})
    return subscribeConfig(() => setConfigVersion((n) => n + 1))
  }, [])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, compact ? 120 : 200)}px`
    }
  }, [message, compact])

  const handleSubmit = () => {
    if (message.trim() && !disabled) {
      if (sendBtnRef.current) {
        gsap.fromTo(
          sendBtnRef.current,
          { scale: 0.9 },
          { scale: 1, duration: 0.4, ease: 'back.out(3)' }
        )
      }
      onSend?.(message, {
        reasoningEffort,
        enableWebSearch,
        model: selectedModel,
      })
      setMessage('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const cfg = getConfig()
  void configVersion
  const defaultModel = cfg?.defaultModel
  const reasoningModels = cfg?.reasoningModels ?? []
  const defaultReasoningEffort = cfg?.defaultReasoningEffort ?? 'medium'
  const effectiveModel = selectedModel ?? defaultModel
  const reasoningSupported = effectiveModel
    ? reasoningModels.some((model) => model.toLowerCase() === effectiveModel.toLowerCase())
    : reasoningModels.length > 0
  const reasoningEnabled = Boolean(reasoningEffort && reasoningSupported)

  const handleToggleReasoning = () => {
    if (disabled || !reasoningSupported) return
    onReasoningEffortChange?.(reasoningEnabled ? null : defaultReasoningEffort)
  }

  const handleToggleWebSearch = () => {
    if (disabled || !cfg?.webSearchConfigured) return
    if (enableWebSearch) {
      if (webSearchBtnRef.current) {
        gsap.fromTo(
          webSearchBtnRef.current,
          { scale: 1 },
          { scale: 0.95, duration: 0.1, yoyo: true, repeat: 1, ease: 'power2.inOut' }
        )
      }
    } else if (webSearchRingRef.current) {
      gsap.fromTo(
        webSearchRingRef.current,
        { scale: 0.8, opacity: 0.8 },
        { scale: 1.2, opacity: 0, duration: 0.4, ease: 'power2.out' }
      )
    }
    onToggleWebSearch?.(!enableWebSearch)
  }

  return (
    <div ref={rootRef} className="relative w-full max-w-[680px] mx-auto">
      {/* Outer glow — subtle in light, rich in dark */}
      <div
        ref={outerGlowRef}
        className="absolute -inset-2 rounded-3xl pointer-events-none hidden dark:block"
        style={{
          opacity: focused ? 1 : 0,
          transform: focused ? 'scale(1)' : 'scale(0.95)',
          boxShadow:
            '0 0 40px rgba(20,136,252,0.35), 0 0 80px rgba(20,136,252,0.15), 0 0 120px rgba(99,102,241,0.1)',
        }}
      />
      <div
        className="absolute -inset-1 rounded-3xl pointer-events-none dark:hidden"
        style={{
          opacity: focused ? 1 : 0,
          boxShadow: '0 0 24px rgba(37,119,255,0.10), 0 8px 24px rgba(15,23,42,0.06)',
          transition: 'opacity 300ms ease',
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

        {/* Inner surface — white card in light, dark glass in dark */}
        <div
          className={`relative rounded-2xl transition-shadow duration-500 bg-white dark:bg-[#1e1e22] ${
            focused
              ? 'shadow-[0_0_0_1px_rgba(37,119,255,0.15),0_4px_24px_rgba(15,23,42,0.08)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_30px_rgba(20,136,252,0.2)]'
              : 'shadow-[0_2px_16px_rgba(15,23,42,0.06)] dark:shadow-[0_2px_20px_rgba(0,0,0,0.4)]'
          }`}
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
              className={`w-full resize-none bg-transparent text-[15px] placeholder:text-slate-400 dark:placeholder:text-[#5a5a5f] text-slate-900 dark:text-white px-4 sm:px-5 focus:outline-none ${
                compact
                  ? 'pt-3 pb-2 min-h-[44px] max-h-[120px]'
                  : 'pt-4 sm:pt-5 pb-3 min-h-[60px] sm:min-h-[80px] max-h-[200px]'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
          </div>

          <div
            className={`flex items-center justify-between flex-wrap gap-2 px-3 sm:px-3 pt-1 ${
              compact ? 'pb-2' : 'pb-3'
            }`}
          >
            <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
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
                  className={`attach-btn flex items-center justify-center size-10 sm:size-10 rounded-full transition-all duration-300 active:scale-95 touch-manipulation ${
                    focused
                      ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-400 dark:hover:bg-blue-500/25'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:bg-white/[0.08] dark:text-[#8a8a8f] dark:hover:bg-white/[0.12] dark:hover:text-white'
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
                    <div className="fixed inset-0 z-40" onClick={() => setShowAttachMenu(false)} />
                    <div
                      className="absolute bottom-full left-0 mb-2 z-50 rounded-xl shadow-xl overflow-hidden bg-white border border-slate-200 dark:bg-[#1a1a1e]/95 dark:border-white/10 dark:backdrop-blur-xl dark:shadow-2xl dark:shadow-black/50"
                      ref={(el) => {
                        if (el)
                          gsap.fromTo(
                            el,
                            { opacity: 0, scale: 0.92, y: 8 },
                            { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(1.7)' }
                          )
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
                            className="w-full flex items-center gap-3 px-3 py-2.5 sm:py-2 rounded-lg transition-all duration-150 touch-manipulation text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#a0a0a5] dark:hover:bg-white/5 dark:hover:text-white"
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
              <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />

              <button
                ref={webSearchBtnRef}
                type="button"
                onClick={handleToggleWebSearch}
                disabled={disabled || !cfg?.webSearchConfigured}
                className={`relative flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-full text-[11px] sm:text-xs font-medium transition-all duration-200 active:scale-95 touch-manipulation min-h-[44px] ${
                  !cfg?.webSearchConfigured
                    ? 'border bg-amber-50 border-amber-200 text-amber-700 cursor-not-allowed dark:bg-amber-500/[0.06] dark:border-amber-500/20 dark:text-amber-200/90'
                    : enableWebSearch
                      ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:ring-blue-400/30'
                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:text-[#8a8a8f] dark:hover:text-white dark:hover:bg-white/5'
                } ${disabled && cfg?.webSearchConfigured ? 'opacity-50 cursor-not-allowed' : ''}`}
                aria-label={enableWebSearch ? '已开启联网搜索' : '联网搜索'}
                title={cfg?.webSearchConfigured ? '联网搜索' : '后端未配置联网搜索'}
              >
                {cfg?.webSearchConfigured && (
                  <span
                    ref={webSearchRingRef}
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{
                      boxShadow: '0 0 0 1.5px rgba(96,165,250,0.6)',
                      opacity: 0,
                      transform: 'scale(0.8)',
                    }}
                    aria-hidden
                  />
                )}
                {cfg?.webSearchConfigured ? (
                  <Globe aria-hidden="true" className="size-4 sm:size-3.5" />
                ) : (
                  <AlertCircle aria-hidden="true" className="size-4 sm:size-3.5" />
                )}
                <span className="hidden sm:inline">
                  {!cfg?.webSearchConfigured ? '联网未配置' : enableWebSearch ? '联网中' : '联网'}
                </span>
                {enableWebSearch && cfg?.webSearchConfigured && (
                  <span className="size-1 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse" />
                )}
              </button>

              <button
                type="button"
                onClick={handleToggleReasoning}
                disabled={disabled || !reasoningSupported}
                className={`flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-full text-[11px] sm:text-xs font-medium transition-all duration-200 active:scale-95 touch-manipulation min-h-[44px] sm:min-h-[auto] ${
                  reasoningEnabled
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:text-[#8a8a8f] dark:hover:text-white dark:hover:bg-white/5'
                } ${disabled || !reasoningSupported ? 'opacity-50 cursor-not-allowed' : ''}`}
                aria-label={reasoningEnabled ? '已开启思考' : '思考'}
                title={reasoningSupported ? '思考' : '当前模型不支持思考'}
              >
                <BrainCircuit className="size-3.5" />
                <span className="hidden sm:inline">{reasoningEnabled ? '思考中' : '思考'}</span>
              </button>
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-2">
              <button
                ref={sendBtnRef}
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || disabled}
                className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-2 rounded-full text-sm font-medium text-white transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 touch-manipulation min-h-[44px] sm:min-h-[auto] ${
                  focused
                    ? 'bg-[#1a94ff] shadow-[0_0_20px_rgba(37,119,255,0.25)] dark:shadow-[0_0_25px_rgba(20,136,252,0.5),0_0_50px_rgba(20,136,252,0.2)]'
                    : 'bg-[#1488fc] shadow-[0_2px_12px_rgba(37,119,255,0.2)] hover:bg-[#1a94ff] hover:shadow-[0_4px_20px_rgba(37,119,255,0.3)] dark:shadow-[0_0_20px_rgba(20,136,252,0.3)] dark:hover:shadow-[0_0_30px_rgba(20,136,252,0.45)]'
                }`}
                aria-label="发送"
              >
                {enableWebSearch && cfg?.webSearchConfigured && (
                  <Globe aria-hidden="true" className="size-3.5" />
                )}
                <span className="hidden sm:inline">发送</span>
                <SendHorizontal className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
