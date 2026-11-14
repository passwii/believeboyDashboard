'use client'

import { useEffect, useState, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Plus,
  Paperclip,
  Image as ImageIcon,
  FileCode,
  SendHorizontal,
  Globe,
  BrainCircuit,
  AlertCircle,
} from 'lucide-react'
import { ModelSelector } from './model-selector'
import styles from './warm-chat.module.css'
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
    <div ref={rootRef} className={`${styles.inputRoot} relative w-full max-w-[680px] mx-auto`}>
      <div
        className={`${styles.inputCard} ${focused ? styles.inputCardFocused : ''} relative transition-shadow duration-500`}
      >
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          disabled={disabled}
          className={`${styles.textarea} w-full resize-none text-[15px] px-4 sm:px-5 focus:outline-none ${
            compact
              ? 'pt-3 pb-2 min-h-[44px] max-h-[120px]'
              : 'pt-4 sm:pt-5 pb-3 min-h-[60px] sm:min-h-[80px] max-h-[200px]'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        />

        <div
          className={`${styles.inputToolbar} flex items-center justify-between flex-wrap gap-2 px-3 pt-1 ${
            compact ? 'pb-2' : 'pb-3'
          }`}
        >
          <div className={`${styles.inputTools} flex items-center gap-1 sm:gap-2 flex-wrap`}>
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
                className={`${styles.iconButton} attach-btn size-10 active:scale-95 touch-manipulation ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                aria-label="添加附件"
              >
                <Plus
                  className={`size-4 sm:size-5 transition-transform duration-[var(--duration-fast)] ${
                    showAttachMenu ? 'rotate-45' : ''
                  }`}
                />
              </button>
              {showAttachMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAttachMenu(false)} />
                  <div
                    className={`${styles.attachMenu} absolute bottom-full left-0 mb-2 z-50 overflow-hidden`}
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
                        { icon: <ImageIcon className="size-4" />, label: '添加图片' },
                        { icon: <FileCode className="size-4" />, label: '导入代码' },
                      ].map((item, i) => (
                        <button
                          type="button"
                          key={i}
                          className={`${styles.attachOption} w-full flex items-center gap-3 px-3 py-2.5 sm:py-2 transition-all duration-150 touch-manipulation`}
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
              className={`${styles.toolButton} ${enableWebSearch ? styles.toolButtonActive : ''} relative flex items-center gap-1 active:scale-95 touch-manipulation ${
                !cfg?.webSearchConfigured || disabled ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              aria-label={enableWebSearch ? '已开启联网搜索' : '联网搜索'}
              title={cfg?.webSearchConfigured ? '联网搜索' : '后端未配置联网搜索'}
            >
              {cfg?.webSearchConfigured && (
                <span
                  ref={webSearchRingRef}
                  className="absolute inset-0 rounded-[inherit] pointer-events-none"
                  style={{ opacity: 0, transform: 'scale(0.8)' }}
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
                <span className={`${styles.typingDots} size-1 rounded-full animate-pulse`} />
              )}
            </button>

            <button
              type="button"
              onClick={handleToggleReasoning}
              disabled={disabled || !reasoningSupported}
              className={`${styles.toolButton} ${reasoningEnabled ? styles.toolButtonActive : ''} flex items-center gap-1 active:scale-95 touch-manipulation ${
                disabled || !reasoningSupported ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              aria-label={reasoningEnabled ? '已开启思考' : '思考'}
              title={reasoningSupported ? '思考' : '当前模型不支持思考'}
            >
              <BrainCircuit className="size-3.5" />
              <span className="hidden sm:inline">{reasoningEnabled ? '思考中' : '思考'}</span>
            </button>
          </div>

          <div className="flex-1" />

          <button
            ref={sendBtnRef}
            type="button"
            onClick={handleSubmit}
            disabled={!message.trim() || disabled}
            className={`${styles.sendButton} ${styles.inputSend} flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 sm:py-2 text-sm font-medium transition-all duration-[var(--duration-quick)] active:scale-95 touch-manipulation min-h-[44px] sm:min-h-[auto]`}
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
  )
}
