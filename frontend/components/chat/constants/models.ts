import { Brain, Cpu, Sparkles, Zap } from 'lucide-react'
import React from 'react'

import type { Model } from '../types'

/**
 * Pinned-model lookup table.
 *
 * The 5 pinned models each get a curated icon + color + Chinese description.
 * The actual model `id` still comes from the backend (`cfg.models`); the
 * lookup is keyed by `id.toLowerCase()`. If the backend ever renames an id,
 * update the `id` field below — the displayed `name`/`description`/`icon`
 * will then follow automatically.
 *
 * Anything not matched here is rendered as a generic "other" model: a single
 * neutral `Cpu` icon, the fixed description `其他模型`, and no badge.
 */
export const PINNED_MODELS: Model[] = [
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    shortName: 'M2H',
    description: '极速智能',
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
    id: 'Nemotron3-Nano',
    name: 'Nemotron 3 Nano',
    shortName: 'N3',
    description: '极速响应',
    icon: React.createElement(Brain, { className: 'size-4 text-emerald-400' }),
  },
  {
    id: 'Deepseek-V4-Flash',
    name: 'DeepSeek V4 Flash',
    shortName: 'D4',
    description: '通用快速',
    icon: React.createElement(Sparkles, { className: 'size-4 text-green-400' }),
  },
  {
    id: 'Nex-N2-Pro',
    name: 'Nex N2 Pro',
    shortName: 'N2',
    description: '性价比 Agent 任务',
    icon: React.createElement(Brain, { className: 'size-4 text-cyan-400' }),
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
