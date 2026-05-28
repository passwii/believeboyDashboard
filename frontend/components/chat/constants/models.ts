import { Zap, Sparkles, Brain } from 'lucide-react'
import React from 'react'
import type { Model } from '../types'

export const models: Model[] = [
  { id: 'sonnet-4.5', name: 'Sonnet 4.5', shortName: 'S4', description: '快速 & 智能', icon: React.createElement(Zap, { className: 'size-4 text-blue-400' }), badge: '默认' },
  { id: 'opus-4.5', name: 'Opus 4.5', shortName: 'O4', description: '最强能力', icon: React.createElement(Sparkles, { className: 'size-4 text-purple-400' }), badge: 'Pro' },
  { id: 'haiku-4.5', name: 'Haiku 4.5', shortName: 'H4', description: '极速响应', icon: React.createElement(Brain, { className: 'size-4 text-emerald-400' }) },
  { id: 'gpt-4o', name: 'GPT-4o', shortName: 'G4', description: 'OpenAI 旗舰', icon: React.createElement(Sparkles, { className: 'size-4 text-green-400' }) },
  { id: 'gemini-2.0', name: 'Gemini 2.0', shortName: 'G2', description: 'Google AI', icon: React.createElement(Brain, { className: 'size-4 text-cyan-400' }) },
]
