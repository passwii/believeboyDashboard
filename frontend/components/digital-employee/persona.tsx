'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface PersonaConfig {
  emoji: string
  tagline: string
  color: string
  colorKey: string
  bgGradient: string
}

export const PERSONA_MAP: Record<string, PersonaConfig> = {
  AUTO_REPORT_UPLOAD: {
    emoji: '📤',
    tagline: '报表快递员',
    color: 'text-blue-500',
    colorKey: 'blue',
    bgGradient: 'from-blue-500/10 to-cyan-500/5',
  },
  SCHEDULED_JOB: {
    emoji: '⏰',
    tagline: '定时指挥官',
    color: 'text-orange-500',
    colorKey: 'orange',
    bgGradient: 'from-orange-500/10 to-amber-500/5',
  },
  RPA_BOT: {
    emoji: '🤖',
    tagline: '流程机器人',
    color: 'text-violet-500',
    colorKey: 'violet',
    bgGradient: 'from-violet-500/10 to-purple-500/5',
  },
  AI_AGENT: {
    emoji: '💬',
    tagline: '洞察分析师',
    color: 'text-emerald-500',
    colorKey: 'emerald',
    bgGradient: 'from-emerald-500/10 to-teal-500/5',
  },
  MONITORING: {
    emoji: '📊',
    tagline: '数据观察员',
    color: 'text-pink-500',
    colorKey: 'pink',
    bgGradient: 'from-pink-500/10 to-rose-500/5',
  },
  DATABASE: {
    emoji: '🗄️',
    tagline: '数据库守护者',
    color: 'text-slate-500',
    colorKey: 'slate',
    bgGradient: 'from-slate-500/10 to-zinc-500/5',
  },
  CUSTOM: {
    emoji: '⚙️',
    tagline: '自定义任务',
    color: 'text-gray-500',
    colorKey: 'gray',
    bgGradient: 'from-gray-500/10 to-neutral-500/5',
  },
}

const PERSONA_HUES: Record<string, string> = {
  blue: '217 91% 60%',
  orange: '25 95% 53%',
  violet: '258 90% 66%',
  emerald: '160 84% 39%',
  pink: '330 81% 60%',
  slate: '210 16% 47%',
  gray: '220 9% 46%',
}

const FALLBACK_HUE = PERSONA_HUES.slate

export function getPersonaGradient(colorKey: string): string {
  const hue = PERSONA_HUES[colorKey] ?? FALLBACK_HUE
  return `linear-gradient(135deg, hsl(${hue} / 0.08) 0%, hsl(${hue} / 0.03) 100%)`
}

export function getPersonaBorder(colorKey: string): string {
  const hue = PERSONA_HUES[colorKey] ?? FALLBACK_HUE
  return `hsl(${hue} / 0.2)`
}

export function getPersona(employeeType: string): PersonaConfig {
  return PERSONA_MAP[employeeType] || PERSONA_MAP.CUSTOM
}

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_MAP: Record<AvatarSize, string> = {
  sm: 'h-9 w-9 text-xl',
  md: 'h-12 w-12 text-2xl',
  lg: 'h-16 w-16 text-3xl',
  xl: 'h-20 w-20 text-4xl',
}

interface EmployeeAvatarProps {
  employeeType?: string
  emoji?: string
  size?: AvatarSize
  status?: DigitalEmployeeStatus
  className?: string
}

const STATUS_DOT_COLORS: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'bg-muted',
  RUNNING: 'bg-blue-500 animate-pulse',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

export function EmployeeAvatar({
  employeeType,
  emoji,
  size = 'md',
  status,
  className = '',
}: EmployeeAvatarProps) {
  const config = employeeType ? PERSONA_MAP[employeeType] : null
  const resolvedEmoji = emoji || config?.emoji || '🤖'
  const colorKey = config?.colorKey || 'slate'

  return (
    <div className={cn('relative inline-flex', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-2xl border-2 shadow-sm',
          SIZE_MAP[size]
        )}
        style={{
          background: getPersonaGradient(colorKey),
          borderColor: getPersonaBorder(colorKey),
        }}
      >
        {resolvedEmoji}
      </div>
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-background',
            STATUS_DOT_COLORS[status]
          )}
        />
      )}
    </div>
  )
}
