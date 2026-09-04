'use client'

import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { Inbox } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import { TASK_BOARD_COLUMNS, TASK_STATUS_LABELS } from '@/lib/crm/enums/task.enum'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'

/** BLF-837：看板列头状态点 → 终端语义色（pending=muted · in_progress=warn · done=pos）。 */
const COLUMN_DOT: Record<string, string> = {
  pending: 'bg-term-faint',
  in_progress: 'bg-term-warn',
  done: 'bg-term-pos',
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
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
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
        // BLF-837：列容器零圆角 + term 边界，拖拽悬停高亮走 term-hover
        'flex min-h-[280px] flex-col border border-term-border bg-term-bg/50 p-1.5 transition-colors',
        isOver && 'border-term-border-strong bg-term-hover'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 px-1">
        <span className={cn('h-1.5 w-1.5 rounded-full', COLUMN_DOT[status])} aria-hidden />
        <h3 className="font-mono text-xs uppercase tracking-wider text-term-muted">
          {TASK_STATUS_LABELS[status]}
        </h3>
        <span
          data-testid={`task-column-count-${status}`}
          className="border border-term-border bg-term-panel px-1 font-mono text-xs tabular-nums text-term-muted"
        >
          {items.length}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1.5">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-8 text-term-faint">
            <Inbox className="h-5 w-5" />
            <span className="font-mono text-xs">暂无任务</span>
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
