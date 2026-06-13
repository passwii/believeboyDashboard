'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Check, Cpu } from 'lucide-react'
import gsap from 'gsap'

import { ensureConfigLoaded, getConfig, subscribe as subscribeConfig } from '@/lib/api/ai-chat-config-store'

import {
  getPinnedModelMeta,
  OTHER_MODEL_DESCRIPTION,
  OTHER_MODEL_ICON,
} from './constants/models'
import type { Model, ModelGroup } from './types'

/**
 * Build a `Model` record for a backend `modelId`.
 *
 * Resolution order:
 *  1. Pinned lookup (`getPinnedModelMeta`) — returns curated icon/name/desc.
 *  2. Generic "other" template — shared `Cpu` icon + `其他模型` description.
 *
 * `badge` is *always* derived from the backend `premiumModels` / `defaultModel`
 * sets — never from the pinned lookup — so the "Pro / 默认" badge reflects
 * what the backend reports, not what's pinned.
 */
function buildModel(
  modelId: string,
  pinnedMeta: Model | null,
  premiumSet: Set<string>,
  defaultModel: string | null
): Model {
  if (pinnedMeta) {
    return {
      id: modelId,
      name: pinnedMeta.name,
      shortName: pinnedMeta.shortName,
      description: pinnedMeta.description,
      icon: pinnedMeta.icon,
      // Badge is NOT inherited from pinned lookup — always derived from
      // backend premium/default sets.
      badge: undefined,
    }
  }
  return {
    id: modelId,
    name: modelId,
    shortName: deriveShortName(modelId),
    description: OTHER_MODEL_DESCRIPTION,
    icon: OTHER_MODEL_ICON,
  }
}

/** `MiMo-V2.5` → `M2` ; `OpenRouter-Free` → `OF` ; fallback to first 2 chars. */
function deriveShortName(modelId: string): string {
  const m = modelId.match(/([a-zA-Z]+)[\s-]*(\d+)/)
  if (m) {
    const letter = m[1].charAt(0).toUpperCase()
    return `${letter}${m[2].charAt(0)}`
  }
  return modelId.slice(0, 2).toUpperCase()
}

function badgeFor(modelId: string, premiumSet: Set<string>, defaultModel: string | null): string | null {
  if (defaultModel && modelId === defaultModel) return '默认'
  if (premiumSet.has(modelId.toLowerCase())) return 'Pro'
  return null
}

export function ModelSelector({ selectedModel, onModelChange }: {
  selectedModel?: string
  onModelChange?: (modelId: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)
  const [othersExpanded, setOthersExpanded] = useState(false)
  const [othersContent, setOthersContent] = useState<HTMLDivElement | null>(null)
  const [othersChevron, setOthersChevron] = useState<SVGSVGElement | null>(null)

  useEffect(() => {
    ensureConfigLoaded().catch(() => {
      // Surfaced by AIChatWindow's banner; this component just falls back to
      // an empty list.
    })
    return subscribeConfig(() => setConfigVersion((n) => n + 1))
  }, [])

  const cfg = getConfig()
  const modelIds = useMemo(() => cfg?.models ?? [], [cfg?.models])
  const premiumSet = useMemo(
    () => new Set((cfg?.premiumModels ?? []).map((m) => m.toLowerCase())),
    [cfg?.premiumModels]
  )
  const defaultModel = cfg?.defaultModel ?? null
  const effectiveSelected = selectedModel ?? defaultModel ?? modelIds[0]
  const current = modelIds.find((m) => m === effectiveSelected) ?? modelIds[0]

  // Split backend model ids into pinned + others. We compare in lowercase
  // because pinned lookup keys are lowercased.
  const { pinnedIds, otherIds } = useMemo(() => {
    const pinned: string[] = []
    const others: string[] = []
    for (const id of modelIds) {
      if (getPinnedModelMeta(id)) pinned.push(id)
      else others.push(id)
    }
    return { pinnedIds: pinned, otherIds: others }
  }, [modelIds])

  const groups: ModelGroup[] = useMemo(() => {
    const pinnedGroup: ModelGroup = {
      id: 'pinned',
      label: '推荐',
      models: pinnedIds.map((id) =>
        buildModel(id, getPinnedModelMeta(id), premiumSet, defaultModel)
      ),
    }
    const othersGroup: ModelGroup | null = otherIds.length
      ? {
          id: 'others',
          label: '其他模型',
          models: otherIds.map((id) =>
            buildModel(id, null, premiumSet, defaultModel)
          ),
          collapsedByDefault: true,
        }
      : null
    return othersGroup ? [pinnedGroup, othersGroup] : [pinnedGroup]
  }, [pinnedIds, otherIds, premiumSet, defaultModel])

  // GSAP animation for the "others" collapse/expand. Respects
  // prefers-reduced-motion.
  useEffect(() => {
    if (!othersContent) return
    const el = othersContent
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (othersExpanded) {
      if (reduced) {
        gsap.set(el, { height: 'auto', opacity: 1 })
      } else {
        gsap.fromTo(
          el,
          { height: 0, opacity: 0 },
          { height: 'auto', opacity: 1, duration: 0.25, ease: 'power2.out' }
        )
      }
    } else if (!el.dataset.initialized || el.style.height === 'auto') {
      // First mount with collapsed state: snap to hidden without animating.
      if (reduced) {
        gsap.set(el, { height: 0, opacity: 0 })
      } else {
        gsap.set(el, { height: 0, opacity: 0 })
      }
      el.dataset.initialized = '1'
    } else {
      if (reduced) {
        gsap.set(el, { height: 0, opacity: 0 })
      } else {
        gsap.to(el, { height: 0, opacity: 0, duration: 0.2, ease: 'power2.in' })
      }
    }
  }, [othersExpanded, othersContent])

  // Chevron rotation
  useEffect(() => {
    if (!othersChevron) return
    gsap.to(othersChevron, {
      rotation: othersExpanded ? 0 : -90, // 0 = down (expanded), -90 = right (collapsed)
      duration: 0.2,
      ease: 'power2.out',
    })
  }, [othersExpanded, othersChevron])

  if (!cfg || modelIds.length === 0) {
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

  // Resolve icon/name/description for the *selected* model so the trigger
  // button reflects the right metadata. `current` is guaranteed non-null
  // here because we early-returned on `modelIds.length === 0`.
  const currentModelMeta: Model = current
    ? buildModel(current, getPinnedModelMeta(current), premiumSet, defaultModel)
    : buildModel(modelIds[0] ?? '', null, premiumSet, defaultModel)

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
        {currentModelMeta?.icon ?? <Cpu className="size-4 text-slate-400" />}
        <span className="hidden xs:inline">{currentModelMeta?.name ?? current}</span>
        <span className="xs:hidden">{currentModelMeta?.shortName ?? deriveShortName(current ?? '')}</span>
        <ChevronDown className={`size-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[260px] sm:min-w-[280px] max-h-[60vh] overflow-y-auto bg-[#1a1a1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl shadow-black/50 overscroll-contain bb-anim-scale-in">
            <div className="p-1.5">
              <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5a5a5f]">选择模型</div>
              {groups.map((group, gIdx) => (
                <ModelGroupSection
                  key={group.id}
                  group={group}
                  isFirst={gIdx === 0}
                  othersExpanded={othersExpanded}
                  onToggleOthers={() => setOthersExpanded((v) => !v)}
                  onContentRef={setOthersContent}
                  onChevronRef={setOthersChevron}
                  currentId={current ?? null}
                  onSelect={handleSelect}
                  premiumSet={premiumSet}
                  defaultModel={defaultModel}
                />
              ))}
              {/* Re-render the version key so React picks up store changes. */}
              <span className="hidden" data-config-version={configVersion} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ModelGroupSection({
  group,
  isFirst,
  othersExpanded,
  onToggleOthers,
  onContentRef,
  onChevronRef,
  currentId,
  onSelect,
  premiumSet,
  defaultModel,
}: {
  group: ModelGroup
  isFirst: boolean
  othersExpanded: boolean
  onToggleOthers: () => void
  onContentRef: (el: HTMLDivElement | null) => void
  onChevronRef: (el: SVGSVGElement | null) => void
  currentId: string | null
  onSelect: (id: string) => void
  premiumSet: Set<string>
  defaultModel: string | null
}) {
  const isCollapsible = !!group.collapsedByDefault

  return (
    <div className={isFirst ? '' : 'mt-1 border-t border-white/5 pt-1'}>
      {isCollapsible ? (
        <button
          type="button"
          onClick={onToggleOthers}
          aria-expanded={othersExpanded}
          aria-controls="model-selector-others"
          className="w-full flex items-center gap-2 px-2.5 py-2 sm:py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5a5a5f] hover:text-[#8a8a8f] transition-colors touch-manipulation min-h-[36px]"
        >
          <ChevronRight
            ref={onChevronRef}
            className="size-3 flex-shrink-0"
            aria-hidden
          />
          <span className="flex-1 text-left">{group.label}</span>
          <span className="text-[10px] font-normal normal-case text-[#5a5a5f]">
            {group.models.length}
          </span>
        </button>
      ) : (
        <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5a5a5f]">
          {group.label}
        </div>
      )}

      {isCollapsible ? (
        <div
          id="model-selector-others"
          ref={onContentRef}
          className="overflow-hidden"
          aria-hidden={!othersExpanded}
        >
          {group.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              isCurrent={currentId === model.id}
              onSelect={onSelect}
              badge={badgeFor(model.id, premiumSet, defaultModel)}
            />
          ))}
        </div>
      ) : (
        group.models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            isCurrent={currentId === model.id}
            onSelect={onSelect}
            badge={badgeFor(model.id, premiumSet, defaultModel)}
          />
        ))
      )}
    </div>
  )
}

function ModelRow({
  model,
  isCurrent,
  onSelect,
  badge,
}: {
  model: Model
  isCurrent: boolean
  onSelect: (id: string) => void
  badge: string | null
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(model.id)}
      className={`w-full flex items-center gap-3 px-2.5 py-3 sm:py-2 rounded-lg text-left transition-all duration-150 touch-manipulation ${
        isCurrent ? 'bg-white/10 text-white' : 'text-[#a0a0a5] hover:bg-white/5 hover:text-white'
      }`}
    >
      <div className="flex-shrink-0">{model.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{model.name}</span>
          {badge && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${
                badge === 'Pro'
                  ? 'bg-purple-500/20 text-purple-300'
                  : 'bg-blue-500/20 text-blue-300'
              }`}
            >
              {badge}
            </span>
          )}
        </div>
        {model.description && (
          <span className="text-[11px] text-[#6a6a6f] line-clamp-1">{model.description}</span>
        )}
      </div>
      {isCurrent && <Check className="size-4 text-blue-400 flex-shrink-0" />}
    </button>
  )
}
