'use client'

import { useDraggable } from '@dnd-kit/core'
import { CalendarClock } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import {
  TASK_PRIORITY_BAR,
  TASK_PRIORITY_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate } from '../task-utils'

/** BLF-837：优先级色条 → 终端语义色（low=faint · medium=accent · high=warn · urgent=neg）。 */
const PRIORITY_TERM_BAR: Record<Task['priority'], string> = {
  low: 'bg-term-faint',
  medium: 'bg-term-accent',
  high: 'bg-term-warn',
  urgent: 'bg-term-neg',
}

/**
 * 看板任务卡片（设计 §8.2；BLF-837 终端规格）：零圆角零阴影、term 边界，
 * 标题 + 客户/线索名 chips + due_date（逾期 neg/今日 warn）+ priority 色条 + type 单色 pill + owner 名（all 视图）。
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
        'group relative cursor-grab overflow-hidden border border-term-border bg-term-panel p-2 pl-3 transition-colors hover:border-term-border-strong active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      {/* priority 色条（终端语义色） */}
      <div
        data-testid={`task-priority-bar-${task.id}`}
        className={cn('absolute inset-y-0 left-0 w-1', PRIORITY_TERM_BAR[task.priority])}
      />
      <div>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug text-term-text">{task.title}</p>
          <span
            className="shrink-0 border border-term-border px-1 font-mono text-[11px] text-term-muted"
          >
            {TASK_TYPE_LABELS[task.type]}
          </span>
        </div>

        {/* 客户/线索名 chips：终端单色（客户=accent 边界、线索=muted 边界） */}
        {linkedName && (
          <span
            data-testid={`task-link-${task.id}`}
            className={cn(
              'mt-1 inline-flex items-center border px-1 font-mono text-[11px]',
              linkedKind === '客户'
                ? 'border-term-accent/40 text-term-accent'
                : 'border-term-border text-term-muted'
            )}
          >
            {linkedKind === '客户' ? '客户' : '线索'} · {linkedName}
          </span>
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span
            data-testid={`task-due-${task.id}`}
            className={cn(
              'inline-flex items-center gap-1 font-mono text-[11px] tabular-nums',
              dueState === 'overdue' && 'font-medium text-term-neg',
              dueState === 'today' && 'font-medium text-term-warn',
              dueState === 'future' && 'text-term-muted',
              dueState === 'none' && 'text-term-faint'
            )}
          >
            {dueText && <CalendarClock className="h-3 w-3" />}
            {dueText || '无截止'}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-term-muted">
            <span
              className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_TERM_BAR[task.priority])}
              aria-hidden
            />
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
