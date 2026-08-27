'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useNotifications } from '@/components/notifications'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import type { Task, TaskInput, TaskStatus } from '@/lib/crm/types'
import {
  TASK_PRIORITY_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS,
  TASK_TYPE_COLORS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { cn } from '@/lib/utils'
import { CrmTaskForm } from '@/components/crm/crm-task-form'
import { formatDueDate } from '@/app/dashboard/crm/tasks/task-utils'

/**
 * 抽屉「任务」tab（P7，BLF-514）：展示关联实体的任务列表 + 新建任务弹窗。
 * 客户/线索详情抽屉内复用；实体经 entityType + entityId 过滤。
 */
export function CrmTaskTab({
  entityType,
  entityId,
}: {
  entityType: 'customer' | 'lead'
  entityId: string
}) {
  const client = useCrmClient()
  const users = useCrmUsers()
  const { notify } = useNotifications()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await client.listTasks({
        scope: 'all',
        ...(entityType === 'customer' ? { customerId: entityId } : { leadId: entityId }),
        pageSize: 50,
      })
      setTasks(page.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载任务失败')
      setTasks(null)
    } finally {
      setLoading(false)
    }
  }, [client, entityType, entityId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleCreate(input: TaskInput) {
    await client.createTask({
      ...input,
      ...(entityType === 'customer' ? { customerId: entityId } : { leadId: entityId }),
    })
    notify({ type: 'success', title: '任务已创建' })
    setCreating(false)
    await load()
  }

  async function handleStatus(task: Task, status: TaskStatus) {
    try {
      if (status === 'done') await client.completeTask(task.id)
      else if (status === 'cancelled') await client.cancelTask(task.id)
      else await client.setTaskStatus(task.id, status)
      notify({
        type: 'success',
        title: status === 'done' ? '任务已完成' : status === 'cancelled' ? '任务已取消' : '状态已更新',
      })
      await load()
    } catch (e) {
      notify({ type: 'error', title: '操作失败', message: e instanceof Error ? e.message : String(e) })
    }
  }

  if (loading && !tasks) {
    return (
      <div className="space-y-3" role="status" aria-label="任务加载中">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (error && !tasks) {
    return <ErrorState title="加载失败" message={error} onRetry={() => void load()} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-term-faint">关联任务 · {tasks?.length ?? 0}</p>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="task-tab-create">
          <Plus className="mr-1 h-4 w-4" /> 新建任务
        </Button>
      </div>

      {!tasks || tasks.length === 0 ? (
        <EmptyState message="暂无关联任务" />
      ) : (
        <ul className="divide-y divide-term-border rounded-none border border-term-border">
          {tasks.map((task) => {
            const linked = task.customerName ?? task.leadName
            const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
            return (
              <li key={task.id} className="space-y-1.5 px-3 py-2.5" data-testid={`task-tab-row-${task.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-term-text">{task.title}</span>
                  <Badge
                    variant="secondary"
                    className={cn('shrink-0 px-1.5 py-0 text-[11px]', TASK_STATUS_COLORS[task.status])}
                  >
                    {TASK_STATUS_LABELS[task.status]}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-term-faint">
                  <Badge variant="outline" className={cn('rounded-none border-term-border px-1.5 py-0 font-mono text-[11px]', TASK_TYPE_COLORS[task.type])}>
                    {TASK_TYPE_LABELS[task.type]}
                  </Badge>
                  <Badge variant="outline" className={cn('rounded-none border-term-border px-1.5 py-0 font-mono text-[11px]', TASK_PRIORITY_COLORS[task.priority])}>
                    {TASK_PRIORITY_LABELS[task.priority]}
                  </Badge>
                  {task.dueDate && <span>{formatDueDate(task.dueDate) || '—'}</span>}
                  {linked && <span>{linkedKind} · {linked}</span>}
                  {task.ownerName && <span>负责人：{task.ownerName}</span>}
                  {task.completedAt && <span>完成于 {new Date(task.completedAt).toLocaleDateString('zh-CN')}</span>}
                </div>
                <div className="flex gap-1.5 pt-0.5">
                  {task.status === 'pending' && (
                    <Button size="sm" variant="outline" onClick={() => handleStatus(task, 'in_progress')}>
                      开始
                    </Button>
                  )}
                  {task.status !== 'done' && task.status !== 'cancelled' && (
                    <Button size="sm" variant="outline" onClick={() => handleStatus(task, 'done')}>
                      完成
                    </Button>
                  )}
                  {task.status !== 'done' && task.status !== 'cancelled' && (
                    <Button size="sm" variant="ghost" onClick={() => handleStatus(task, 'cancelled')}>
                      取消
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="w-full gap-0 rounded-none border-term-border bg-term-panel p-0 sm:max-w-md">
          <SheetHeader className="rounded-none border-b border-term-border px-3 py-2">
            <SheetTitle className="font-mono text-sm uppercase tracking-wider text-term-muted">新建任务</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <CrmTaskForm users={users} onSubmit={handleCreate} submitText="创建任务" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
