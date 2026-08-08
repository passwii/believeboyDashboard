'use client'

import { useDraggable } from '@dnd-kit/core'
import { CalendarClock } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import { Badge } from '@/components/ui/badge'
import {
  TASK_PRIORITY_BAR,
  TASK_PRIORITY_LABELS,
  TASK_TYPE_COLORS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate } from '../task-utils'

/**
 * 看板任务卡片（设计 §8.2）：
 * 标题 + 客户/线索名 chips + due_date（逾期红/今日黄）+ priority 色条 + type 徽章 + owner 名（all 视图）。
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
      className={cn(
        'group relative cursor-grab overflow-hidden rounded-md border border-border/70 bg-card p-3 shadow-sm transition-colors hover:border-border active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      {/* priority 色条 */}
      <div
        data-testid={`task-priority-bar-${task.id}`}
        className={cn('absolute inset-y-0 left-0 w-1', TASK_PRIORITY_BAR[task.priority])}
      />
      <div className="pl-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug text-foreground">{task.title}</p>
          <Badge
            variant="outline"
            className={cn('shrink-0 px-1.5 py-0 text-[11px]', TASK_TYPE_COLORS[task.type])}
          >
            {TASK_TYPE_LABELS[task.type]}
          </Badge>
        </div>

        {/* 客户/线索名 chips */}
        {linkedName && (
          <span
            data-testid={`task-link-${task.id}`}
            className={cn(
              'mt-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[11px]',
              linkedKind === '客户'
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                : 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300'
            )}
          >
            {linkedKind === '客户' ? '客户' : '线索'} · {linkedName}
          </span>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <span
            data-testid={`task-due-${task.id}`}
            className={cn(
              'inline-flex items-center gap-1 text-xs',
              dueState === 'overdue' && 'font-medium text-rose-600 dark:text-rose-400',
              dueState === 'today' && 'font-medium text-amber-600 dark:text-amber-400',
              dueState === 'future' && 'text-muted-foreground',
              dueState === 'none' && 'text-muted-foreground/70'
            )}
          >
            {dueText && <CalendarClock className="h-3 w-3" />}
            {dueText || '无截止'}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn('h-1.5 w-1.5 rounded-full', TASK_PRIORITY_BAR[task.priority])} />
            {TASK_PRIORITY_LABELS[task.priority]}
            {showOwner && task.ownerName && (
              <span data-testid={`task-owner-${task.id}`}>· {task.ownerName}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
