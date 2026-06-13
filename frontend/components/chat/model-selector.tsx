'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Check, Sparkles, Brain, Zap, Cpu } from 'lucide-react'
import { ensureConfigLoaded, getConfig, subscribe as subscribeConfig } from '@/lib/api/ai-chat-config-store'

// Map a backend model id to a small visual icon + label. The "pro / default"
// badges are derived from membership in the `premiumModels` / `defaultModel`
// sets returned by the backend. Anything we don't recognise falls through to
// a generic icon — the dropdown still works, it just doesn't have a custom
// icon for the id.
const ICON_BY_KEYWORD: Array<[RegExp, (className: string) => React.ReactNode]> = [
  [/^opus|^o\d/i, (cn) => <Sparkles className={`${cn} text-purple-400`} />],
  [/^haiku|^h\d|^gemini/i, (cn) => <Brain className={`${cn} text-emerald-400`} />],
  [/^gpt/i, (cn) => <Sparkles className={`${cn} text-green-400`} />],
  [/^sonnet|^s\d/i, (cn) => <Zap className={`${cn} text-blue-400`} />],
]

function iconFor(modelId: string) {
  for (const [pattern, render] of ICON_BY_KEYWORD) {
    if (pattern.test(modelId)) return render('size-4')
  }
  return <Cpu className="size-4 text-blue-400" />
}

function shortName(modelId: string): string {
  // "claude-sonnet-4-5" → "S4" ; "gpt-4o" → "G4" ; fall back to first 2 chars
  const m = modelId.match(/([a-zA-Z]+)[\s-]*(\d+)/)
  if (m) {
    const letter = m[1].charAt(0).toUpperCase()
    return `${letter}${m[2].charAt(0)}`
  }
  return modelId.slice(0, 2).toUpperCase()
}

export function ModelSelector({ selectedModel, onModelChange }: {
  selectedModel?: string
  onModelChange?: (modelId: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)

  useEffect(() => {
    // Make sure the config is loaded and we re-render whenever it changes.
    ensureConfigLoaded().catch(() => {
      // Surfaced by AIChatWindow's banner; this component just falls back to
      // an empty list.
    })
    return subscribeConfig(() => setConfigVersion((n) => n + 1))
  }, [])

  const cfg = getConfig()
  const models = cfg?.models ?? []
  const premiumSet = new Set((cfg?.premiumModels ?? []).map((m) => m.toLowerCase()))
  const effectiveSelected = selectedModel ?? cfg?.defaultModel ?? models[0]

  // If the user hasn't picked a model and we have a default, mark that as
  // the "currently selected" so the dropdown highlights it.
  const current = models.find((m) => m === effectiveSelected) ?? models[0]

  if (!cfg || models.length === 0) {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-1 px-2 py-1.5 rounded-full text-[11px] sm:text-xs font-medium text-[#5a5a5f] cursor-not-allowed"
        aria-label="模型不可用"
      >
        <Cpu className="size-4" />
        <span className="hidden xs:inline">模型不可用</span>
      </button>
    )
  }

  const handleSelect = (modelId: string) => {
    setIsOpen(false)
    onModelChange?.(modelId)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 sm:py-1.5 rounded-full text-[11px] sm:text-xs font-medium transition-all duration-200 text-[#8a8a8f] hover:text-white hover:bg-white/5 active:scale-95 touch-manipulation min-h-[36px] sm:min-h-[auto]"
      >
        {iconFor(current)}
        <span className="hidden xs:inline">{current}</span>
        <span className="xs:hidden">{shortName(current)}</span>
        <ChevronDown className={`size-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[240px] sm:min-w-[260px] max-h-[60vh] overflow-y-auto bg-[#1a1a1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/50 overscroll-contain bb-anim-scale-in">
            <div className="p-1.5">
              <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5a5a5f]">选择模型</div>
              {models.map((modelId) => {
                const isPremium = premiumSet.has(modelId.toLowerCase())
                const isDefault = cfg?.defaultModel === modelId
                return (
                  <button
                    type="button"
                    key={modelId}
                    onClick={() => handleSelect(modelId)}
                    className={`w-full flex items-center gap-3 px-2.5 py-3 sm:py-2 rounded-lg text-left transition-all duration-150 touch-manipulation ${
                      current === modelId ? 'bg-white/10 text-white' : 'text-[#a0a0a5] hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <div className="flex-shrink-0">{iconFor(modelId)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{modelId}</span>
                        {isDefault && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 bg-blue-500/20 text-blue-300">
                            默认
                          </span>
                        )}
                        {isPremium && !isDefault && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 bg-purple-500/20 text-purple-300">
                            Pro
                          </span>
                        )}
                      </div>
                    </div>
                    {current === modelId && <Check className="size-4 text-blue-400 flex-shrink-0" />}
                  </button>
                )
              })}
              {/* Re-render the version key so React picks up store changes. */}
              <span className="hidden" data-config-version={configVersion} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
