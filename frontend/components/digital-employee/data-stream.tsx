'use client'

import { useEffect, useState } from 'react'
import type { DigitalEmployee } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface StreamMessage {
  id: string
  text: string
  subtext?: string
  showProgress?: boolean
  progress?: number
}

interface DataStreamProps {
  employee: DigitalEmployee
  /** 最新任务信息（从活动流或轮询获取） */
  currentTask?: {
    task_name: string
    progress_percent: number
    current_step: string | null
    status: string
  } | null
  /** 数据流窗口变体样式 */
  variant?: 'default' | 'success' | 'error' | 'warning'
  className?: string
}

function buildMessages(
  employee: DigitalEmployee,
  currentTask?: DataStreamProps['currentTask']
): StreamMessage[] {
  const messages: StreamMessage[] = []

  if (currentTask && currentTask.status === 'RUNNING') {
    messages.push({
      id: `task-${currentTask.task_name}`,
      text: currentTask.current_step || currentTask.task_name,
      subtext: currentTask.progress_percent > 0 ? `${currentTask.progress_percent}%` : undefined,
      showProgress: currentTask.progress_percent > 0,
      progress: currentTask.progress_percent,
    })
  }

  if (employee.description) {
    messages.push({
      id: 'desc',
      text: employee.description,
    })
  }

  if (messages.length === 0) {
    const statusText: Record<string, string> = {
      IDLE: '等待下一个任务…',
      RUNNING: '正在处理…',
      SUCCEEDED: '上次任务已完成',
      FAILED: '遇到问题，需要关注',
      SUSPENDED: '已暂停',
    }
    messages.push({
      id: 'status',
      text: statusText[employee.status] || '待命中',
    })
  }

  return messages
}

const VARIANT_STYLES: Record<string, { border: string; bg: string; text: string }> = {
  default: {
    border: 'border-term-border',
    bg: 'bg-term-bg',
    text: 'text-term-text',
  },
  success: {
    border: 'border-term-pos/40',
    bg: 'bg-term-pos/5',
    text: 'text-term-pos',
  },
  error: {
    border: 'border-term-neg/40',
    bg: 'bg-term-neg/5',
    text: 'text-term-neg',
  },
  warning: {
    border: 'border-term-warn/40',
    bg: 'bg-term-warn/5',
    text: 'text-term-warn',
  },
}

export function DataStream({
  employee,
  currentTask,
  variant = 'default',
  className,
}: DataStreamProps) {
  const messages = buildMessages(employee, currentTask)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [fadeState, setFadeState] = useState<'in' | 'out'>('in')

  // Auto-rotate messages
  useEffect(() => {
    if (messages.length <= 1) return

    const interval = setInterval(() => {
      setFadeState('out')
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % messages.length)
        setFadeState('in')
      }, 300)
    }, 4500)

    return () => clearInterval(interval)
  }, [messages.length])

  // Reset index when messages change
  useEffect(() => {
    setCurrentIndex(0)
    setFadeState('in')
  }, [messages.length])

  const current = messages[currentIndex] || messages[0]
  if (!current) return null

  const variantStyle = VARIANT_STYLES[variant]

  return (
    <div className={cn('space-y-2', className)}>
      <div
        className={cn(
          'rounded-none border px-3 py-2.5 min-h-[72px] transition-all duration-[var(--duration-medium)]',
          variantStyle.border,
          variantStyle.bg,
          fadeState === 'in' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
        )}
      >
        <p className={cn('text-sm leading-relaxed', variantStyle.text)}>{current.text}</p>
        {current.showProgress && current.progress !== undefined && (
          <div className="mt-2">
            <div className="h-1 w-full overflow-hidden rounded-none bg-term-border">
              <div
                className="h-full rounded-none bg-term-accent transition-all duration-[var(--duration-very-slow)]"
                style={{ width: `${Math.min(100, Math.max(0, current.progress))}%` }}
              />
            </div>
          </div>
        )}
        {current.subtext && !current.showProgress && (
          <p className="mt-1 font-mono text-xs text-term-muted">{current.subtext}</p>
        )}
      </div>

      {/* Dot indicators */}
      {messages.length > 1 && (
        <div className="flex justify-center gap-1.5">
          {messages.map((msg, i) => (
            <span
              key={msg.id}
              className={cn(
                'h-1 w-1 rounded-full transition-colors duration-[var(--duration-quick)]',
                i === currentIndex ? 'bg-foreground' : 'bg-muted-foreground/30'
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
