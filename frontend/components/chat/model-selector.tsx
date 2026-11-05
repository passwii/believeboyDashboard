'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Check, Cpu, X } from 'lucide-react'
import gsap from 'gsap'

import {
  ensureConfigLoaded,
  getConfig,
  subscribe as subscribeConfig,
} from '@/lib/api/ai-chat-config-store'

import { getPinnedModelMeta, OTHER_MODEL_DESCRIPTION, OTHER_MODEL_ICON } from './constants/models'
import type { Model, ModelGroup } from './types'
import styles from './warm-chat.module.css'

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

function badgeFor(
  modelId: string,
  premiumSet: Set<string>,
  defaultModel: string | null
): string | null {
  if (defaultModel && modelId === defaultModel) return '默认'
  if (premiumSet.has(modelId.toLowerCase())) return 'Pro'
  return null
}

/** Returns true on the first non-SSR render where the viewport is ≥ 1024px wide. */
function useIsDesktop(breakpointPx = 1024): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${breakpointPx}px)`)
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
    // `breakpointPx` is a constant in our only caller; intentionally omitted
    // to keep the listener stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return isDesktop
}

export function ModelSelector({
  selectedModel,
  onModelChange,
}: {
  selectedModel?: string
  onModelChange?: (modelId: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)
  const [othersExpanded, setOthersExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false) // desktop-only: "其他模型" right-side panel
  const [othersContent, setOthersContent] = useState<HTMLDivElement | null>(null)
  const [othersChevron, setOthersChevron] = useState<SVGSVGElement | null>(null)
  const [drawerPanel, setDrawerPanel] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const isDesktop = useIsDesktop(1024)

  useEffect(() => {
    ensureConfigLoaded().catch(() => {
      // Surfaced by AIChatWindow's banner; this component just falls back to
      // an empty list.
    })
    return subscribeConfig(() => setConfigVersion((n) => n + 1))
  }, [])

  // Esc closes the main dropdown + the drawer
  useEffect(() => {
    if (!isOpen && !drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, drawerOpen])

  // Close the dropdown when the pointer moves outside its root. This replaces
  // the old fullscreen backdrop so the desktop "other models" panel can sit
  // directly beside the dropdown without covering the viewport.
  useEffect(() => {
    if (!isOpen) return
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setIsOpen(false)
        setDrawerOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [isOpen])

  // If we transition desktop → mobile while drawer is open, close it.
  useEffect(() => {
    if (!isDesktop && drawerOpen) setDrawerOpen(false)
  }, [isDesktop, drawerOpen])

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
          models: otherIds.map((id) => buildModel(id, null, premiumSet, defaultModel)),
          collapsedByDefault: true,
        }
      : null
    return othersGroup ? [pinnedGroup, othersGroup] : [pinnedGroup]
  }, [pinnedIds, otherIds, premiumSet, defaultModel])

  // On mobile, the "others" group uses an inline up/down expand (animated).
  // On desktop, the chevron opens a right-side panel inside the dropdown.
  const handleToggleOthers = () => {
    if (isDesktop) {
      setDrawerOpen((v) => !v)
    } else {
      setOthersExpanded((v) => !v)
    }
  }

  // GSAP animation for the mobile inline expand/collapse.
  useEffect(() => {
    if (!othersContent) return
    const el = othersContent
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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

  // Chevron rotation (mobile inline; on desktop the chevron is in the dropdown
  // header, not in the drawer — we still rotate it for visual feedback).
  useEffect(() => {
    if (!othersChevron) return
    const expanded = isDesktop ? drawerOpen : othersExpanded
    gsap.to(othersChevron, {
      rotation: expanded ? 0 : -90, // 0 = down (expanded), -90 = right (collapsed)
      duration: 0.2,
      ease: 'power2.out',
    })
  }, [othersExpanded, drawerOpen, othersChevron, isDesktop])

  // Desktop side-panel fade in / out (no x translation: the panel is
  // absolutely positioned next to the trigger, not a viewport-edge drawer).
  useEffect(() => {
    if (!isDesktop || !drawerPanel) return
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (drawerPanel) {
      if (drawerOpen) {
        if (reduced) {
          gsap.set(drawerPanel, { opacity: 1 })
        } else {
          gsap.fromTo(
            drawerPanel,
            { opacity: 0 },
            { opacity: 1, duration: 0.2, ease: 'power2.out' }
          )
        }
      } else {
        if (reduced) {
          gsap.set(drawerPanel, { opacity: 0 })
        } else {
          gsap.to(drawerPanel, { opacity: 0, duration: 0.18, ease: 'power2.in' })
        }
      }
    }
  }, [drawerOpen, drawerPanel, isDesktop])

  if (!cfg || modelIds.length === 0) {
    return (
      <button
        type="button"
        disabled
        className={`${styles.toolButton} flex items-center gap-1 px-2 py-1.5 text-[11px] sm:text-xs font-medium cursor-not-allowed`}
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
    setDrawerOpen(false)
    onModelChange?.(modelId)
  }

  const othersGroup = groups.find((g) => g.id === 'others') ?? null
  const otherModels = othersGroup?.models ?? []

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (isOpen) {
            setIsOpen(false)
            setDrawerOpen(false)
          } else {
            setIsOpen(true)
          }
        }}
        className={`${styles.toolButton} flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 text-[11px] sm:text-xs font-medium active:scale-95 touch-manipulation`}
      >
        {currentModelMeta?.icon ?? (
          <Cpu className="size-4 text-[var(--warm-ledger-color-text-muted)]" />
        )}
        <span className="hidden xs:inline">{currentModelMeta?.name ?? current}</span>
        <span className="xs:hidden">
          {currentModelMeta?.shortName ?? deriveShortName(current ?? '')}
        </span>
        <ChevronDown
          className={`size-3.5 transition-transform duration-[var(--duration-fast)] ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setIsOpen(false)
              setDrawerOpen(false)
            }}
          />
          {/* Wrapper that holds the main dropdown + the optional "其他模型"
              side panel side-by-side. Both panels anchor to the same bottom
              edge so the right panel visually stacks next to (not below)
              the dropdown. `items-end` keeps the main dropdown glued to the
              trigger top so opening the side panel doesn't shift it up or
              down — only the side panel grows upward as needed. */}
          <div className="absolute bottom-full left-0 mb-2 z-50 flex items-end gap-2 bb-anim-scale-in">
            <div className={`${styles.modelMenu} min-w-[260px] sm:min-w-[280px] max-h-[60vh] overflow-y-auto overscroll-contain`}>
              <div className="p-1.5">
                <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  选择模型
                </div>
                {groups.map((group, gIdx) => (
                  <ModelGroupSection
                    key={group.id}
                    group={group}
                    isFirst={gIdx === 0}
                    othersExpanded={othersExpanded}
                    onToggleOthers={handleToggleOthers}
                    onContentRef={setOthersContent}
                    onChevronRef={setOthersChevron}
                    currentId={current ?? null}
                    onSelect={handleSelect}
                    premiumSet={premiumSet}
                    defaultModel={defaultModel}
                    isDesktop={isDesktop}
                    drawerOpen={drawerOpen}
                  />
                ))}
                {/* Re-render the version key so React picks up store changes. */}
                <span className="hidden" data-config-version={configVersion} />
              </div>
            </div>

            {/* Desktop "其他模型" right-side panel — sits to the right of the
                main dropdown. Only rendered when the user has explicitly
                toggled it (drawerOpen) so the main dropdown still has a
                clear affordance on its own. Scrollable for long model lists. */}
            {isDesktop && othersGroup && drawerOpen && (
              <div
                ref={setDrawerPanel}
                role="dialog"
                aria-modal="false"
                aria-label="其他模型"
                data-side-panel="model-others"
                className={`${styles.modelPanel} w-[300px] max-w-[85vw] max-h-[60vh] flex flex-col pointer-events-auto`}
                style={{ opacity: 0 }}
              >
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--warm-ledger-color-hairline)]">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider">
                      {othersGroup.label}
                    </div>
                    <div className="text-xs mt-0.5">{otherModels.length} 个模型</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    className={`${styles.actionButton} p-1.5 touch-manipulation`}
                    aria-label="关闭"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 overscroll-contain">
                  {otherModels.map((model) => (
                    <DrawerModelRow
                      key={model.id}
                      model={model}
                      isCurrent={current === model.id}
                      onSelect={handleSelect}
                      badge={badgeFor(model.id, premiumSet, defaultModel)}
                    />
                  ))}
                </div>
              </div>
            )}
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
  isDesktop,
  drawerOpen,
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
  isDesktop: boolean
  drawerOpen: boolean
}) {
  const isCollapsible = !!group.collapsedByDefault

  // On desktop, "other models" expand into a right-side panel inside the
  // dropdown (no inline section there) — so we don't render the inline content
  // in that mode. We still render the section header so the user can see the
  // trigger.
  const renderInline = isCollapsible && !isDesktop
  const isOpen = isDesktop ? drawerOpen : othersExpanded

  return (
    <div
      className={
        isFirst
          ? ''
          : 'mt-1 border-t border-[var(--warm-ledger-color-hairline)] pt-1'
      }
    >
      {isCollapsible ? (
        <button
          type="button"
          onClick={onToggleOthers}
          data-testid="model-selector-others-toggle"
          aria-expanded={isOpen}
          aria-controls={isDesktop ? undefined : 'model-selector-others'}
          className="w-full flex items-center gap-2 px-2.5 py-2 sm:py-1.5 text-[10px] font-semibold uppercase tracking-wider touch-manipulation min-h-[36px]"
        >
          <ChevronRight ref={onChevronRef} className="size-3 flex-shrink-0" aria-hidden />
          <span className="flex-1 text-left">{group.label}</span>
          <span className="text-[10px] font-normal normal-case">
            {group.models.length}
          </span>
        </button>
      ) : (
        <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider">
          {group.label}
        </div>
      )}

      {renderInline ? (
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
      ) : !isCollapsible ? (
        group.models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            isCurrent={currentId === model.id}
            onSelect={onSelect}
            badge={badgeFor(model.id, premiumSet, defaultModel)}
          />
        ))
      ) : null}
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
      className={`${styles.modelRow} ${isCurrent ? styles.modelRowActive : ''} w-full flex items-center gap-3 px-2.5 py-3 sm:py-2 text-left transition-all duration-150 touch-manipulation`}
    >
      <div className="flex-shrink-0">{model.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{model.name}</span>
          {badge && (
            <span
              className={`${styles.modelBadge} text-[10px] px-1.5 py-0.5 font-medium flex-shrink-0`}
            >
              {badge}
            </span>
          )}
        </div>
        {model.description && (
          <span className="text-[11px] line-clamp-1">{model.description}</span>
        )}
      </div>
      {isCurrent && <Check className={`${styles.modelCheck} size-4 flex-shrink-0`} />}
    </button>
  )
}

/**
 * Spacious row layout for the desktop drawer. Wider hit target + more
 * breathing room for model id + description.
 */
function DrawerModelRow({
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
      className={`${styles.modelRow} ${isCurrent ? styles.modelRowActive : ''} w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-150`}
    >
      <div className="flex-shrink-0">{model.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{model.name}</span>
          {badge && (
            <span
              className={`${styles.modelBadge} text-[10px] px-1.5 py-0.5 font-medium flex-shrink-0`}
            >
              {badge}
            </span>
          )}
        </div>
        {model.description && (
          <span className="text-[11px] line-clamp-1">{model.description}</span>
        )}
      </div>
      {isCurrent && <Check className={`${styles.modelCheck} size-4 flex-shrink-0`} />}
    </button>
  )
}
