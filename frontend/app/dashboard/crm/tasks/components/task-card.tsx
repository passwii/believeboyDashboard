'use client'

import { useDraggable } from '@dnd-kit/core'
import { CalendarClock } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import {
  TASK_PRIORITY_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import {
  WarmCrmStatusPill,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate } from '../task-utils'
import styles from './task-card.module.css'

const PRIORITY_TONE: Record<Task['priority'], WarmCrmStatusTone> = {
  low: 'neutral',
  medium: 'accent',
  high: 'accent',
  urgent: 'negative',
}

/**
 * 看板任务卡片：保留优先级、关联客户/线索、截止状态和负责人信息，
 * 视觉层级由 Warm token 与真实字段建立。
 */
export function TaskCard({ task, showOwner }: { task: Task; showOwner: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  })

  const dueState = dueDateState(task.dueDate)
  const dueText = formatDueDate(task.dueDate)
  const linkedName = task.customerName ?? task.leadName
  const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : null

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid={`task-card-${task.id}`}
      data-priority={task.priority}
      className={cn(styles.card, isDragging && styles.dragging)}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      <div
        data-testid={`task-priority-bar-${task.id}`}
        className={styles.priorityBar}
        data-priority={task.priority}
        aria-hidden="true"
      />

      <div className={styles.content}>
        <div className={styles.heading}>
          <p className={styles.title}>{task.title}</p>
          <div className={styles.pills}>
            <WarmCrmStatusPill tone="neutral">
              {TASK_TYPE_LABELS[task.type]}
            </WarmCrmStatusPill>
            <WarmCrmStatusPill tone={PRIORITY_TONE[task.priority]}>
              {TASK_PRIORITY_LABELS[task.priority]}
            </WarmCrmStatusPill>
          </div>
        </div>

        {linkedName ? (
          <span
            data-testid={`task-link-${task.id}`}
            className={styles.link}
            data-kind={linkedKind === '客户' ? 'customer' : 'lead'}
          >
            {linkedKind} · {linkedName}
          </span>
        ) : null}

        <div className={styles.meta}>
          <span
            data-testid={`task-due-${task.id}`}
            className={cn(styles.due, styles[`due_${dueState}`])}
          >
            {dueText ? <CalendarClock aria-hidden="true" className={styles.dueIcon} /> : null}
            {dueText || '无截止'}
          </span>
          {showOwner && task.ownerName ? (
            <span data-testid={`task-owner-${task.id}`} className={styles.owner}>
              {task.ownerName}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
