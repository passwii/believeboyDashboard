/**
 * P7 看板拖拽逻辑（BLF-512）。
 *
 * 与 React 组件解耦成纯函数/工厂，便于单测：看板渲染、拖拽 handler 调
 * setTaskStatus、乐观更新 + 失败回滚、type 筛选。
 */
import type { DragEndEvent } from '@dnd-kit/core'
import type { Task, TaskStatus } from '@/lib/crm/types'
import { TASK_BOARD_COLUMNS } from '@/lib/crm/enums/task.enum'

/** 目标列必须是看板三列之一（cancelled 不入看板）。 */
export function isBoardStatus(status: string): status is TaskStatus {
  return (TASK_BOARD_COLUMNS as string[]).includes(status)
}

/** 乐观更新：把任务移到目标状态列（纯函数；失败回滚时用传入的原始数组）。 */
export function applyStatusMove(tasks: Task[], taskId: string, status: TaskStatus): Task[] {
  return tasks.map((t) => (t.id === taskId ? { ...t, status } : t))
}

export interface DragMoveDeps {
  /** 调 POST /crm/tasks/{id}/status。 */
  setTaskStatus: (id: string, status: TaskStatus) => Promise<Task>
  /** 失败提示（notify error）。 */
  onError: (message: string) => void
}

export type SetTasksFn = (updater: Task[] | ((prev: Task[]) => Task[])) => void

/**
 * 生成 DndContext.onDragEnd 处理器：
 * 1. 解析 active 任务 + 落点列；目标列非法或未变则忽略；
 * 2. 乐观更新本地状态（先移列）；
 * 3. 调 setTaskStatus；成功用服务端结果校正（completed_at 等），失败回滚原列表 + 提示。
 */
export function createDragEndHandler(
  tasks: Task[] | null,
  setTasks: SetTasksFn,
  deps: DragMoveDeps
): (event: DragEndEvent) => Promise<void> {
  return async (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    if (!overId || !tasks) return
    if (!isBoardStatus(overId)) return
    const target = overId as TaskStatus
    const task = tasks.find((t) => t.id === activeId)
    if (!task || task.status === target) return

    const previous = tasks
    setTasks(applyStatusMove(tasks, activeId, target))
    try {
      const updated = await deps.setTaskStatus(activeId, target)
      // 服务端为准：合并 updated 覆盖本地乐观项（如 completed_at 由后端置位）
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (e) {
      setTasks(previous) // 失败回滚
      deps.onError(e instanceof Error ? e.message : '状态更新失败，已还原')
    }
  }
}
