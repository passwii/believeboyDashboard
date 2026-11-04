'use client'

import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { Inbox } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import { TASK_BOARD_COLUMNS, TASK_STATUS_LABELS } from '@/lib/crm/enums/task.enum'
import { WarmCrmSection } from '@/components/dashboard-v2/warm-ledger/crm'
import { cn } from '@/lib/utils'
import { TaskCard } from './task-card'
import styles from './task-kanban.module.css'

/**
 * 任务看板：pending → in_progress → done；cancelled 仅列表可见。
 * 列头 type 筛选由页面工具栏驱动，拖拽仍走既有的乐观更新与回滚逻辑。
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
      <div className={styles.board}>
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
  const items = tasks.filter((task) => task.status === status)

  return (
    <div
      ref={setNodeRef}
      data-testid={`task-column-${status}`}
      className={cn(styles.column, isOver && styles.dropActive)}
    >
      <WarmCrmSection
        className={styles.columnSection}
        bodyClassName={styles.columnBody}
        title={
          <span className={styles.columnTitle}>
            <span
              aria-hidden="true"
              className={styles.statusDot}
              data-status={status}
            />
            {TASK_STATUS_LABELS[status]}
          </span>
        }
        actions={
          <span
            data-testid={`task-column-count-${status}`}
            className={styles.count}
          >
            {items.length}
          </span>
        }
      >
        {items.length === 0 ? (
          <div className={styles.empty}>
            <Inbox aria-hidden="true" className={styles.emptyIcon} />
            <span>暂无任务</span>
          </div>
        ) : (
          items.map((task) => (
            <TaskCard key={task.id} task={task} showOwner={showOwner} />
          ))
        )}
      </WarmCrmSection>
    </div>
  )
}
