'use client'

import { useEffect, useState } from 'react'
import type { DigitalEmployee } from '@/types/digital-employee'
import { cn } from '@/lib/utils'
import { DURATION } from '@/lib/motion/tokens'

import styles from './digital-employee-warm.module.css'

/**
 * 淡出 / 淡入时长（ms）。
 *
 * **必须与下面 `duration-[var(--duration-medium)]` 同源**：轮换回调在这个时长后
 * 才换内容并反向插值。两边各自写字面量会漂移（曾经 timer 300ms / CSS 350ms，
 * 淡出没走完就换内容，每次自动轮换都有一次可见的 content pop），所以从
 * `@/lib/motion/tokens` 的 `DURATION.medium`（= --duration-medium = 350ms）单点取值。
 */
const FADE_DURATION_MS = DURATION.medium * 1000

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
      }, FADE_DURATION_MS)
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

  return (
    <div className={cn(styles.dataStream, className)}>
      <div
        className={styles.streamPanel}
        data-testid="data-stream-panel"
        data-fade-state={fadeState}
        data-variant={variant}
      >
        <p className={styles.streamText}>{current.text}</p>
        {current.showProgress && current.progress !== undefined && (
          <div className={styles.streamProgressTrack}>
            <div
              className={styles.streamProgressFill}
              style={{ width: `${Math.min(100, Math.max(0, current.progress))}%` }}
            />
          </div>
        )}
        {current.subtext && !current.showProgress && (
          <p className={styles.streamSubtext}>{current.subtext}</p>
        )}
      </div>

      {/* Dot indicators */}
      {messages.length > 1 && (
        <div className={styles.streamDots}>
          {messages.map((msg, i) => (
            <span
              key={msg.id}
              className={styles.streamDot}
              data-active={i === currentIndex}
            />
          ))}
        </div>
      )}
    </div>
  )
}
