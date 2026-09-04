import { Brain, Cpu, Gauge, Rocket, Sparkles, Zap } from 'lucide-react'
import React from 'react'

import type { Model } from '../types'

/**
 * Pinned-model lookup table.
 *
 * The pinned models each get a curated icon + color + Chinese description.
 * The actual model `id` still comes from the backend (`cfg.models`, fetched
 * live from the provider's /models endpoint); the lookup is keyed by
 * `id.toLowerCase()`. If the provider renames an id, update the `id` field
 * below — the displayed `name`/`description`/`icon` will then follow.
 *
 * NOTE: the "Pro / 默认" badge is NOT read from this table — it is always
 * derived from the backend `premiumModels` / `defaultModel` sets (see
 * model-selector.tsx `badgeFor`). The `badge` field here is documentation
 * only; keep it in sync with `AI_CHAT_PREMIUM_MODELS` in backend/.env.
 *
 * Anything not matched here is rendered as a generic "other" model: a single
 * neutral `Cpu` icon, the fixed description `其他模型`, and no badge.
 */
export const PINNED_MODELS: Model[] = [
  {
    id: 'Believeboy-Nano',
    name: 'Believeboy Nano',
    shortName: 'BN',
    description: '极速轻量',
    icon: React.createElement(Zap, { className: 'size-4 text-blue-400' }),
  },
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    shortName: 'M3',
    description: '最强能力',
    icon: React.createElement(Sparkles, { className: 'size-4 text-purple-400' }),
    badge: 'Pro',
  },
  {
    id: 'DeepSeek-V4-Pro',
    name: 'DeepSeek V4 Pro',
    shortName: 'D4P',
    description: '深度推理',
    icon: React.createElement(Brain, { className: 'size-4 text-indigo-400' }),
    badge: 'Pro',
  },
  {
    id: 'DeepSeek-V4-Flash',
    name: 'DeepSeek V4 Flash',
    shortName: 'D4F',
    description: '通用快速',
    icon: React.createElement(Gauge, { className: 'size-4 text-green-400' }),
  },
  {
    id: 'qwen3.8-max-preview',
    name: 'Qwen 3.8 Max',
    shortName: 'Q3.8',
    description: '长文本预览',
    icon: React.createElement(Rocket, { className: 'size-4 text-amber-400' }),
  },
]

/** Lookup by lowercased id — returns `undefined` for non-pinned models. */
const PINNED_BY_ID: Map<string, Model> = new Map(
  PINNED_MODELS.map((m) => [m.id.toLowerCase(), m] as const)
)

/** Display metadata for an un-pinned model — shared icon/color/description. */
export const OTHER_MODEL_ICON = React.createElement(Cpu, { className: 'size-4 text-slate-400' })
export const OTHER_MODEL_DESCRIPTION = '其他模型'

/** Return curated metadata for a pinned model id, or `null` for "use generic". */
export function getPinnedModelMeta(modelId: string): Model | null {
  return PINNED_BY_ID.get(modelId.toLowerCase()) ?? null
}
