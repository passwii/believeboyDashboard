'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Plus, Lightbulb, Paperclip, Image, FileCode,
  ChevronDown, Check, Sparkles, Zap, Brain, Bolt,
  SendHorizontal, Bot, User
} from 'lucide-react'
import { AIChatMessageContent } from '@/components/ai-chat-message-content'

// ─── Types ───────────────────────────────────────────────────────────────────────

interface Model {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  badge?: string
}

interface TextSegment {
  text: string
  highlight?: boolean
  speed: number
}

type Phase = 'landing' | 'transitioning' | 'chat'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

// ─── Simulated Streaming ─────────────────────────────────────────────────────────

const DEMO_REPLY = `## 构建计划

很高兴为你规划！基于你的需求，我建议分三步走：

### 第一步：基础架构
- 搭建项目脚手架
- 配置路由与状态管理
- 设计组件层次

### 第二步：核心功能
- 实现数据流管道
- 对接 API 接口
- 添加错误边界处理

### 第三步：优化上线
- 性能调优与懒加载
- 单元测试覆盖
- CI/CD 部署

需要我先从哪一步开始？`

function useSimulatedStream(onChunk: (delta: string) => void, onDone: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idxRef = useRef(0)
  const activeRef = useRef(false)

  const start = useCallback(() => {
    idxRef.current = 0
    activeRef.current = true

    const tick = () => {
      if (!activeRef.current || idxRef.current >= DEMO_REPLY.length) {
        activeRef.current = false
        onDone()
        return
      }
      const chunkSize = Math.random() < 0.1 ? 2 : 1
      const chunk = DEMO_REPLY.slice(idxRef.current, idxRef.current + chunkSize)
      idxRef.current += chunkSize
      onChunk(chunk)
      timerRef.current = setTimeout(tick, 25 + Math.random() * 15)
    }

    timerRef.current = setTimeout(tick, 500)
  }, [onChunk, onDone])

  const stop = useCallback(() => {
    activeRef.current = false
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  useEffect(() => () => stop(), [stop])

  return { start, stop }
}

// ─── Animation Styles ─────────────────────────────────────────────────────────────

const animationStyles = `
  @keyframes bb-fade-up {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes bb-scale-in {
    from { opacity: 0; transform: scale(0.92); }
    to   { opacity: 1; transform: scale(1); }
  }
  @keyframes bb-glow-pulse {
    0%, 100% { opacity: 1;   transform: translateX(-50%) scale(1);    }
    50%      { opacity: 0.45; transform: translateX(-50%) scale(1.06); }
  }
  @keyframes bb-glow-pulse-secondary {
    0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1.03); }
    50%      { opacity: 1;    transform: translateX(-50%) scale(0.97); }
  }
  @keyframes bb-cursor-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0; }
  }
  @keyframes bb-border-rotate {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes bb-glow-intensity {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.7; }
  }
  @keyframes bb-arcs-entrance {
    0%   { opacity: 0; transform: translateX(-50%) rotate(180deg) scale(0.85); }
    60%  { opacity: 1; transform: translateX(-50%) rotate(180deg) scale(1.02); }
    100% { opacity: 1; transform: translateX(-50%) rotate(180deg) scale(1); }
  }
  @keyframes bb-chat-enter {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .bb-anim-fade-up {
    opacity: 0;
    animation: bb-fade-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .bb-anim-scale-in {
    opacity: 0;
    animation: bb-scale-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .bb-glow-pulse {
    animation: bb-glow-pulse 4s ease-in-out infinite;
    will-change: opacity, transform;
  }
  .bb-glow-pulse-secondary {
    animation: bb-glow-pulse-secondary 4.8s ease-in-out infinite;
    will-change: opacity, transform;
  }
  .bb-border-rotate {
    animation: bb-border-rotate 15s linear infinite;
  }
  .bb-glow-intensity {
    animation: bb-glow-intensity 2s ease-in-out infinite;
  }
  .bb-cursor-blink {
    animation: bb-cursor-blink 0.8s step-end infinite;
  }
  .bb-arcs-entrance {
    animation: bb-arcs-entrance 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both;
  }
  .bb-chat-enter {
    animation: bb-chat-enter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
`

// ─── Typewriter Hook ──────────────────────────────────────────────────────────────

function useTypewriter(segments: TextSegment[], startDelay = 0) {
  const [state, setState] = useState({ segIdx: 0, charIdx: 0, done: false })
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), startDelay)
    return () => clearTimeout(timer)
  }, [startDelay])

  useEffect(() => {
    if (!started || state.done) return

    if (state.segIdx >= segments.length) {
      setState(s => ({ ...s, done: true }))
      return
    }

    const seg = segments[state.segIdx]
    if (state.charIdx >= seg.text.length) {
      const t = setTimeout(() => {
        setState(s => ({ segIdx: s.segIdx + 1, charIdx: 0, done: false }))
      }, 120)
      return () => clearTimeout(t)
    }

    const t = setTimeout(() => {
      setState(s => ({ ...s, charIdx: s.charIdx + 1 }))
    }, seg.speed)
    return () => clearTimeout(t)
  }, [started, state.segIdx, state.charIdx, state.done, segments])

  return { ...state, started }
}

// ─── Typewriter Text ──────────────────────────────────────────────────────────────

function TypewriterText({
  segments,
  startDelay = 0,
  className = '',
}: {
  segments: TextSegment[]
  startDelay?: number
  className?: string
}) {
  const { segIdx, charIdx, done, started } = useTypewriter(segments, startDelay)
  const showCursor = started && !done

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (i > segIdx) return null
        const visibleChars = i < segIdx ? seg.text.length : charIdx
        const visible = seg.text.slice(0, visibleChars)
        if (!visible) return null

        return seg.highlight ? (
          <span
            key={i}
            className="inline-block italic bg-gradient-to-b from-[#4da5fc] via-[#4da5fc] to-white bg-clip-text text-transparent px-1.5"
          >
            {visible}
          </span>
        ) : (
          <React.Fragment key={i}>{visible}</React.Fragment>
        )
      })}
      {showCursor && (
        <span
          className="inline-block w-[3px] h-[0.8em] bg-blue-400/80 ml-0.5 align-middle bb-cursor-blink"
          aria-hidden
        />
      )}
    </span>
  )
}

// ─── Models ───────────────────────────────────────────────────────────────────────

const models: Model[] = [
  { id: 'sonnet-4.5', name: 'Sonnet 4.5', description: '快速 & 智能', icon: <Zap className="size-4 text-blue-400" />, badge: '默认' },
  { id: 'opus-4.5', name: 'Opus 4.5', description: '最强能力', icon: <Sparkles className="size-4 text-purple-400" />, badge: 'Pro' },
  { id: 'haiku-4.5', name: 'Haiku 4.5', description: '极速响应', icon: <Brain className="size-4 text-emerald-400" /> },
  { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI 旗舰', icon: <Sparkles className="size-4 text-green-400" /> },
  { id: 'gemini-2.0', name: 'Gemini 2.0', description: 'Google AI', icon: <Brain className="size-4 text-cyan-400" /> },
]

// ─── Model Selector ───────────────────────────────────────────────────────────────

function ModelSelector({ selectedModel = 'sonnet-4.5', onModelChange }: {
  selectedModel?: string
  onModelChange?: (model: Model) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [selected, setSelected] = useState(models.find(m => m.id === selectedModel) || models[0])

  const handleSelect = (model: Model) => {
    setSelected(model)
    setIsOpen(false)
    onModelChange?.(model)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200 text-[#8a8a8f] hover:text-white hover:bg-white/5 active:scale-95"
      >
        {selected.icon}
        <span>{selected.name}</span>
        <ChevronDown className={`size-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[220px] bg-[#1a1a1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden bb-anim-scale-in">
            <div className="p-1.5">
              <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5a5a5f]">选择模型</div>
              {models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  onClick={() => handleSelect(model)}
                  className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-all duration-150 ${
                    selected.id === model.id ? 'bg-white/10 text-white' : 'text-[#a0a0a5] hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <div className="flex-shrink-0">{model.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{model.name}</span>
                      {model.badge && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          model.badge === 'Pro' ? 'bg-purple-500/20 text-purple-300' : 'bg-blue-500/20 text-blue-300'
                        }`}>{model.badge}</span>
                      )}
                    </div>
                    <span className="text-[11px] text-[#6a6a6f]">{model.description}</span>
                  </div>
                  {selected.id === model.id && <Check className="size-4 text-blue-400 flex-shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Chat Input ───────────────────────────────────────────────────────────────────

function ChatInput({ onSend, placeholder = '你想构建什么？', compact = false }: {
  onSend?: (message: string) => void
  placeholder?: string
  compact?: boolean
}) {
  const [message, setMessage] = useState('')
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, compact ? 120 : 200)}px`
    }
  }, [message, compact])

  const handleSubmit = () => {
    if (message.trim()) {
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
    <div className="relative w-full max-w-[680px] mx-auto">
      {/* Outer glow */}
      <div
        className={`absolute -inset-2 rounded-3xl pointer-events-none transition-opacity duration-500 ${
          focused ? 'opacity-100' : 'opacity-0 hover:opacity-60'
        }`}
        style={{
          boxShadow: focused
            ? '0 0 40px rgba(20,136,252,0.35), 0 0 80px rgba(20,136,252,0.15), 0 0 120px rgba(99,102,241,0.1)'
            : '0 0 30px rgba(20,136,252,0.2), 0 0 60px rgba(20,136,252,0.08)',
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
              className={`w-full resize-none bg-transparent text-[15px] text-white placeholder-[#5a5a5f] px-5 focus:outline-none ${
                compact ? 'pt-3 pb-2 min-h-[44px] max-h-[120px]' : 'pt-5 pb-3 min-h-[80px] max-h-[200px]'
              }`}
              style={{ height: compact ? '44px' : '80px' }}
            />
          </div>

          <div className={`flex items-center justify-between px-3 pt-1 ${compact ? 'pb-2' : 'pb-3'}`}>
            <div className="flex items-center gap-1">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowAttachMenu(!showAttachMenu)}
                  className={`flex items-center justify-center size-8 rounded-full transition-all duration-300 active:scale-95 ${
                    focused
                      ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
                      : 'bg-white/[0.08] text-[#8a8a8f] hover:bg-white/[0.12] hover:text-white'
                  }`}
                >
                  <Plus className={`size-4 transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`} />
                </button>
                {showAttachMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAttachMenu(false)} />
                    <div className="absolute bottom-full left-0 mb-2 z-50 bg-[#1a1a1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden bb-anim-scale-in">
                      <div className="p-1.5 min-w-[180px]">
                        {[
                          { icon: <Paperclip className="size-4" />, label: '上传文件' },
                          { icon: <Image className="size-4" />, label: '添加图片' },
                          { icon: <FileCode className="size-4" />, label: '导入代码' },
                        ].map((item, i) => (
                          <button type="button" key={i} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[#a0a0a5] hover:bg-white/5 hover:text-white transition-all duration-150">
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

            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium transition-all duration-300 ${
                  focused
                    ? 'text-blue-400/80 hover:text-blue-300 hover:bg-blue-500/10'
                    : 'text-[#6a6a6f] hover:text-white hover:bg-white/5'
                }`}
              >
                <Lightbulb className="size-4" />
                <span className="hidden sm:inline">规划</span>
              </button>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim()}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium text-white transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 ${
                  focused
                    ? 'bg-[#1a94ff] shadow-[0_0_25px_rgba(20,136,252,0.5),0_0_50px_rgba(20,136,252,0.2)]'
                    : 'bg-[#1488fc] shadow-[0_0_20px_rgba(20,136,252,0.3)] hover:bg-[#1a94ff] hover:shadow-[0_0_30px_rgba(20,136,252,0.45)]'
                }`}
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

// ─── Ray Background (arcs animate upward to expand black fill) ─────────────────────

function RayBackground({ arcsUp }: { arcsUp?: boolean }) {
  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none select-none">
      <div className="absolute inset-0 bg-[#0f0f0f]" />

      {/* Primary glow — blue core */}
      <div
        className="absolute left-1/2 w-[4000px] h-[1800px] sm:w-[6000px] bb-glow-pulse"
        style={{
          background: `radial-gradient(circle at center 800px, rgba(20, 136, 252, 0.9) 0%, rgba(20, 136, 252, 0.4) 14%, rgba(20, 136, 252, 0.2) 18%, rgba(20, 136, 252, 0.1) 22%, rgba(17, 17, 20, 0.2) 28%)`
        }}
      />

      {/* Secondary glow — violet wash */}
      <div
        className="absolute left-1/2 w-[4000px] h-[1600px] sm:w-[5500px] bb-glow-pulse-secondary"
        style={{
          background: `radial-gradient(ellipse at center 700px, rgba(99, 102, 241, 0.35) 0%, rgba(139, 92, 246, 0.15) 12%, rgba(20, 136, 252, 0.08) 20%, transparent 30%)`
        }}
      />

      {/* Horizon glow */}
      <div
        className="absolute left-1/2 w-[5000px] h-[300px] sm:w-[7000px] bb-glow-pulse"
        style={{
          top: '48%',
          background: `radial-gradient(ellipse at center, rgba(56, 189, 248, 0.18) 0%, rgba(20, 136, 252, 0.08) 40%, transparent 70%)`,
          animationDelay: '2s',
        }}
      />

      {/* Concentric arcs — translate upward on arcsUp to expand black fill */}
      <div
        className="absolute left-1/2 w-[1600px] h-[1600px] sm:w-[3043px] sm:h-[2865px] bb-arcs-entrance"
        style={{
          transform: 'translateX(-50%) rotate(180deg)',
          top: arcsUp ? '-30%' : '50%',
          transition: 'top 0.8s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="absolute w-full h-full rounded-full -mt-[13px]" style={{ background: 'radial-gradient(43.89% 25.74% at 50.02% 97.24%, #111114 0%, #0f0f0f 100%)', border: '16px solid white', transform: 'rotate(180deg)', zIndex: 5 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[11px]" style={{ border: '23px solid #b7d7f6', transform: 'rotate(180deg)', zIndex: 4 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[8px]" style={{ border: '23px solid #8fc1f2', transform: 'rotate(180deg)', zIndex: 3 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f] -mt-[4px]" style={{ border: '23px solid #64acf6', transform: 'rotate(180deg)', zIndex: 2 }} />
        <div className="absolute w-full h-full rounded-full bg-[#0f0f0f]" style={{ border: '20px solid #1172e2', boxShadow: '0 -15px 24.8px rgba(17, 114, 226, 0.6)', transform: 'rotate(180deg)', zIndex: 1 }} />
      </div>
    </div>
  )
}

// ─── Announcement Badge ───────────────────────────────────────────────────────────

function AnnouncementBadge({ text, href = '#' }: { text: string; href?: string }) {
  const content = (
    <>
      <span className="absolute top-0 left-0 right-0 h-1/2 pointer-events-none opacity-70 mix-blend-overlay" style={{ background: 'radial-gradient(ellipse at center top, rgba(255, 255, 255, 0.15) 0%, transparent 70%)' }} />
      <span className="absolute -top-px left-1/2 -translate-x-1/2 h-[2px] w-[100px] opacity-60" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(37, 119, 255, 0.8) 20%, rgba(126, 93, 225, 0.8) 50%, rgba(59, 130, 246, 0.8) 80%, transparent 100%)', filter: 'blur(0.5px)' }} />
      <Bolt className="size-4 relative z-10 text-white" />
      <span className="relative z-10 text-white font-medium">{text}</span>
    </>
  )

  const baseClass = 'relative inline-flex items-center gap-2 px-5 py-2 min-h-[40px] rounded-full text-sm overflow-hidden transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] cursor-pointer bb-anim-scale-in'
  const style = {
    background: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))',
    backdropFilter: 'blur(20px) saturate(140%)',
    boxShadow: 'inset 0 1px rgba(255,255,255,0.2), inset 0 -1px rgba(0,0,0,0.1), 0 8px 32px -8px rgba(0,0,0,0.1), 0 0 0 1px rgba(255,255,255,0.08)',
    animationDelay: '0.2s',
  }

  return href !== '#' ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={baseClass} style={style}>{content}</a>
  ) : (
    <button type="button" className={baseClass} style={style}>{content}</button>
  )
}

// ─── Floating Particles ───────────────────────────────────────────────────────────

function FloatingParticles() {
  const particles = useRef([
    { size: 2, x: '15%', y: '20%', dur: 6, delay: 0, opacity: 0.3, dx: [8, -6, 4], dy: [-12, 10, 6] },
    { size: 1.5, x: '80%', y: '15%', dur: 8, delay: 1, opacity: 0.2, dx: [11, -8, 6], dy: [-14, 13, 8] },
    { size: 1, x: '25%', y: '70%', dur: 7, delay: 2, opacity: 0.25, dx: [14, -10, 8], dy: [-16, 16, 10] },
    { size: 2, x: '70%', y: '75%', dur: 9, delay: 0.5, opacity: 0.15, dx: [17, -12, 10], dy: [-18, 19, 12] },
    { size: 1.5, x: '50%', y: '30%', dur: 10, delay: 3, opacity: 0.2, dx: [20, -14, 12], dy: [-20, 22, 14] },
    { size: 1, x: '90%', y: '50%', dur: 6.5, delay: 1.5, opacity: 0.3, dx: [23, -16, 14], dy: [-22, 25, 16] },
    { size: 1.5, x: '10%', y: '55%', dur: 7.5, delay: 2.5, opacity: 0.2, dx: [26, -18, 16], dy: [-24, 28, 18] },
  ]).current

  const keyframesCSS = particles
    .map((p, i) => `
      @keyframes bb-float-${i} {
        0%, 100% { transform: translate(0, 0); opacity: ${p.opacity}; }
        25%  { transform: translate(${p.dx[0]}px, ${p.dy[0]}px); opacity: ${p.opacity * 1.5}; }
        50%  { transform: translate(${p.dx[1]}px, ${p.dy[1]}px); opacity: ${p.opacity * 0.7}; }
        75%  { transform: translate(${p.dx[2]}px, ${p.dy[2]}px); opacity: ${p.opacity * 1.2}; }
      }
    `)
    .join('\n')

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <style dangerouslySetInnerHTML={{ __html: keyframesCSS }} />
      {particles.map((p, i) => (
        <div
          key={i}
          className="absolute rounded-full bg-blue-400"
          style={{
            width: p.size, height: p.size, left: p.x, top: p.y, opacity: p.opacity,
            animation: `bb-float-${i} ${p.dur}s ease-in-out ${p.delay}s infinite`,
          }}
        />
      ))}
    </div>
  )
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-2">
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="h-2 w-2 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────────

interface BoltChatProps {
  title?: string
  titleHighlight?: string
  subtitle?: string
  announcementText?: string
  announcementHref?: string
  placeholder?: string
  onSend?: (message: string) => void
}

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
      // ── First send: trigger the full transition ──
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
      // ── Subsequent sends: just add messages ──
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

      {/* ═══ Layer 1: Glow Background ═══
          Always present. Arcs slide up on transition to expand black fill. */}
      <div className="absolute inset-0">
        <RayBackground arcsUp={arcsUp} />
        <FloatingParticles />
      </div>

      {/* ═══ Layer 2: Landing Content ═══
          Badge + Title + Subtitle. Fades out during transition. */}
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

      {/* ═══ Layer 4: Chat Messages ═══
          Rendered after first send. Fades in on the dark background. */}
      {hasMessages && (
        <div
          ref={chatScrollRef}
          className={`absolute inset-0 overflow-y-auto px-4 pt-6 pb-[100px] ${
            isChat ? 'bb-chat-enter' : 'opacity-0'
          }`}
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((msg, index) => (
              <div
                key={msg.id}
                className={`flex animate-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <div className={`group relative max-w-[85%] flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] border border-white/[0.06]">
                    {msg.role === 'assistant'
                      ? <Bot className="h-4 w-4 text-blue-400/70" />
                      : <User className="h-4 w-4 text-white/50" />
                    }
                  </div>
                  <div className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`px-4 py-3 ${
                        msg.role === 'user'
                          ? 'bg-white/[0.08] rounded-2xl rounded-tr-md text-white'
                          : 'text-[#e0e0e0]'
                      }`}
                    >
                      {msg.role === 'user' ? (
                        <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{msg.content}</p>
                      ) : msg.content ? (
                        <AIChatMessageContent content={msg.content} className="[&_p]:text-[15px] [&_p]:leading-7 [&_p]:text-[#e0e0e0] [&_h2]:text-white [&_h3]:text-white [&_li]:text-[#d0d0d0]" />
                      ) : (
                        <TypingIndicator />
                      )}
                    </div>
                    {msg.streaming && msg.content && (
                      <span className="text-xs text-blue-400/50 flex items-center gap-1">
                        <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                        生成中...
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Layer 5: Input Box ═══
          Always present. CSS transition slides it from center to bottom. */}
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
