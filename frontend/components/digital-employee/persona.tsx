'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

import styles from './digital-employee-warm.module.css'

interface PersonaConfig {
  emoji: string
  tagline: string
  colorKey: string
}

export const PERSONA_MAP: Record<string, PersonaConfig> = {
  AUTO_REPORT_UPLOAD: {
    emoji: '📤',
    tagline: '报表快递员',
    colorKey: 'blue',
  },
  SCHEDULED_JOB: {
    emoji: '⏰',
    tagline: '定时指挥官',
    colorKey: 'orange',
  },
  RPA_BOT: {
    emoji: '🤖',
    tagline: '流程机器人',
    colorKey: 'violet',
  },
  AI_AGENT: {
    emoji: '💬',
    tagline: '洞察分析师',
    colorKey: 'emerald',
  },
  MONITORING: {
    emoji: '📊',
    tagline: '数据观察员',
    colorKey: 'pink',
  },
  DATABASE: {
    emoji: '🗄️',
    tagline: '数据库守护者',
    colorKey: 'slate',
  },
  CUSTOM: {
    emoji: '⚙️',
    tagline: '自定义任务',
    colorKey: 'gray',
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

interface EmployeeAvatarProps {
  employeeType?: string
  emoji?: string
  size?: AvatarSize
  status?: DigitalEmployeeStatus
  className?: string
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

  return (
    <div className={cn(styles.avatar, className)} data-size={size}>
      <div className={styles.avatarFace}>{resolvedEmoji}</div>
      {status && (
        <span className={styles.avatarStatusDot} data-status={status} aria-hidden="true" />
      )}
    </div>
  )
}
