'use client'

import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { Inbox } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import { TASK_BOARD_COLUMNS, TASK_STATUS_LABELS } from '@/lib/crm/enums/task.enum'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'

const COLUMN_ACCENT: Record<string, string> = {
  pending: 'bg-slate-200 dark:bg-slate-700',
  in_progress: 'bg-sky-400',
  done: 'bg-emerald-500',
}

/**
 * 任务看板（设计 §8.2）：三列 pending → in_progress → done；
 * cancelled 不入看板（列表可见）。列头 type 筛选由外层 toolbar 驱动（服务端过滤）。
 */
export function TaskKanban({
  tasks,
  onDragEnd,
  showOwner,
}: {
  tasks: Task[]
  onDragEnd: (event: DragEndEvent) => void
  /** all 视图显示负责人名。 */
  showOwner: boolean
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {TASK_BOARD_COLUMNS.map((status) => (
          <TaskColumn key={status} status={status} tasks={tasks} showOwner={showOwner} />
        ))}
      </div>
    </DndContext>
  )
}

function TaskColumn({
  status,
  tasks,
  showOwner,
}: {
  status: Task['status']
  tasks: Task[]
  showOwner: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const items = tasks.filter((t) => t.status === status)

  return (
    <div
      ref={setNodeRef}
      data-testid={`task-column-${status}`}
      className={cn(
        'flex min-h-[280px] flex-col rounded-lg border border-border/60 bg-muted/40 p-2 transition-colors',
        isOver && 'border-primary/60 bg-primary/5'
      )}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className={cn('h-2 w-2 rounded-full', COLUMN_ACCENT[status])} />
        <h3 className="text-sm font-semibold text-foreground">{TASK_STATUS_LABELS[status]}</h3>
        <span
          data-testid={`task-column-count-${status}`}
          className="rounded bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {items.length}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-8 text-muted-foreground/70">
            <Inbox className="h-5 w-5" />
            <span className="text-xs">暂无任务</span>
          </div>
        ) : (
          items.map((task) => (
            <TaskCard key={task.id} task={task} showOwner={showOwner} />
          ))
        )}
      </div>
    </div>
  )
}
