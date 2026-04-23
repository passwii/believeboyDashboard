'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface PersonaConfig {
  emoji: string
  tagline: string
  mood: string
  color: string
  bgGradient: string
}

export const PERSONA_MAP: Record<string, PersonaConfig> = {
  AUTO_REPORT_UPLOAD: {
    emoji: '📤',
    tagline: '报表快递员',
    mood: '⚡',
    color: 'text-blue-500',
    bgGradient: 'from-blue-500/10 to-cyan-500/5',
  },
  SCHEDULED_JOB: {
    emoji: '⏰',
    tagline: '定时指挥官',
    mood: '🎯',
    color: 'text-orange-500',
    bgGradient: 'from-orange-500/10 to-amber-500/5',
  },
  RPA_BOT: {
    emoji: '🤖',
    tagline: '流程机器人',
    mood: '🔧',
    color: 'text-violet-500',
    bgGradient: 'from-violet-500/10 to-purple-500/5',
  },
  AI_AGENT: {
    emoji: '💬',
    tagline: '洞察分析师',
    mood: '🧠',
    color: 'text-emerald-500',
    bgGradient: 'from-emerald-500/10 to-teal-500/5',
  },
  MONITORING: {
    emoji: '📊',
    tagline: '数据观察员',
    mood: '👁️',
    color: 'text-pink-500',
    bgGradient: 'from-pink-500/10 to-rose-500/5',
  },
  DATABASE: {
    emoji: '🗄️',
    tagline: '数据库守护者',
    mood: '🛡️',
    color: 'text-slate-500',
    bgGradient: 'from-slate-500/10 to-zinc-500/5',
  },
  CUSTOM: {
    emoji: '⚙️',
    tagline: '自定义员工',
    mood: '🔩',
    color: 'text-gray-500',
    bgGradient: 'from-gray-500/10 to-neutral-500/5',
  },
}

const STATUS_MOODS: Record<DigitalEmployeeStatus, { label: string; animation: string; dot: string }> = {
  IDLE: { label: '待命中', animation: 'opacity-60', dot: 'bg-slate-400' },
  RUNNING: { label: '工作中', animation: 'animate-pulse', dot: 'bg-blue-500 animate-ping' },
  SUCCEEDED: { label: '已完成', animation: 'animate-bounce [animation-duration:2s]', dot: 'bg-emerald-500' },
  FAILED: { label: '遇到问题', animation: '[animation:shake_0.5s_ease-in-out]', dot: 'bg-red-500' },
  SUSPENDED: { label: '已暂停', animation: '', dot: 'bg-amber-500' },
}

const PERSONA_COLORS: Record<string, string> = {
  AUTO_REPORT_UPLOAD: 'blue',
  SCHEDULED_JOB: 'orange',
  RPA_BOT: 'violet',
  AI_AGENT: 'emerald',
  MONITORING: 'pink',
  DATABASE: 'slate',
  CUSTOM: 'gray',
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

export function EmployeeAvatar({ employeeType, emoji, size = 'md', status, className = '' }: EmployeeAvatarProps) {
  const config = employeeType ? PERSONA_MAP[employeeType] : null
  const resolvedEmoji = emoji || config?.emoji || '🤖'
  const colorKey = employeeType && PERSONA_COLORS[employeeType] ? PERSONA_COLORS[employeeType] : 'slate'
  const colorClass = `bg-${colorKey}-100 text-${colorKey}-700`
  const borderClass = `border-${colorKey}-200/50`
  const moodConfig = status ? STATUS_MOODS[status] : null

  return (
    <div className={cn('relative inline-flex', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-2xl border-2 shadow-sm',
          borderClass,
          colorClass,
          SIZE_MAP[size],
        )}
      >
        {resolvedEmoji}
      </div>
      {moodConfig && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-background',
            moodConfig.dot,
          )}
        />
      )}
    </div>
  )
}