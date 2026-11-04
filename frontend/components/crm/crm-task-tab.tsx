'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  WarmCrmRecordDrawer,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmToolbar,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import type { Task, TaskInput, TaskStatus } from '@/lib/crm/types'
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { CrmTaskForm } from '@/components/crm/crm-task-form'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate } from '@/app/dashboard/crm/tasks/task-utils'
import styles from './crm-task-tab.module.css'

const STATUS_TONE: Record<Task['status'], WarmCrmStatusTone> = {
  pending: 'accent',
  in_progress: 'accent',
  done: 'positive',
  cancelled: 'neutral',
}

const PRIORITY_TONE: Record<Task['priority'], WarmCrmStatusTone> = {
  low: 'neutral',
  medium: 'accent',
  high: 'accent',
  urgent: 'negative',
}

/**
 * 抽屉「任务」tab：展示关联实体的任务列表 + 新建任务。
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
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载任务失败')
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
        title:
          status === 'done'
            ? '任务已完成'
            : status === 'cancelled'
              ? '任务已取消'
              : '状态已更新',
      })
      await load()
    } catch (statusError) {
      notify({
        type: 'error',
        title: '操作失败',
        message: statusError instanceof Error ? statusError.message : String(statusError),
      })
    }
  }

  if (loading && !tasks) {
    return (
      <div className={styles.root} data-warm-task-tab>
        <WarmCrmState kind="loading" title="任务加载中" />
      </div>
    )
  }

  if (error && !tasks) {
    return (
      <div className={styles.root} data-warm-task-tab>
        <WarmCrmState
          kind="error"
          title="加载任务失败"
          detail={error}
          action={<WarmButton onClick={() => void load()}>重试</WarmButton>}
        />
      </div>
    )
  }

  return (
    <div className={styles.root} data-warm-task-tab>
      <WarmCrmToolbar
        ariaLabel="关联任务工具栏"
        start={<p className={styles.count}>关联任务 · {tasks?.length ?? 0}</p>}
        end={
          <WarmButton onClick={() => setCreating(true)} data-testid="task-tab-create">
            <Plus aria-hidden="true" className={styles.actionIcon} />
            新建任务
          </WarmButton>
        }
      />

      {!tasks || tasks.length === 0 ? (
        <WarmCrmState kind="empty" title="暂无关联任务" />
      ) : (
        <ul className={styles.list}>
          {tasks.map((task) => {
            const linked = task.customerName ?? task.leadName
            const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
            const due = dueDateState(task.dueDate)
            return (
              <li
                key={task.id}
                className={styles.row}
                data-testid={`task-tab-row-${task.id}`}
              >
                <div className={styles.rowHeading}>
                  <span className={styles.title}>{task.title}</span>
                  <div className={styles.pills}>
                    <WarmCrmStatusPill tone="neutral">
                      {TASK_TYPE_LABELS[task.type]}
                    </WarmCrmStatusPill>
                    <WarmCrmStatusPill tone={PRIORITY_TONE[task.priority]}>
                      {TASK_PRIORITY_LABELS[task.priority]}
                    </WarmCrmStatusPill>
                    <WarmCrmStatusPill tone={STATUS_TONE[task.status]}>
                      {TASK_STATUS_LABELS[task.status]}
                    </WarmCrmStatusPill>
                  </div>
                </div>

                <div className={styles.meta}>
                  {task.dueDate ? (
                    <span className={cn(styles.due, styles[`due_${due}`])}>
                      {formatDueDate(task.dueDate) || '—'}
                    </span>
                  ) : null}
                  {linked ? <span>{linkedKind} · {linked}</span> : null}
                  {task.ownerName ? <span>负责人：{task.ownerName}</span> : null}
                  {task.completedAt ? (
                    <span>
                      完成于 {new Date(task.completedAt).toLocaleDateString('zh-CN')}
                    </span>
                  ) : null}
                </div>

                <div className={styles.actions}>
                  {task.status === 'pending' ? (
                    <WarmButton
                      className={styles.compactButton}
                      onClick={() => handleStatus(task, 'in_progress')}
                    >
                      开始
                    </WarmButton>
                  ) : null}
                  {task.status !== 'done' && task.status !== 'cancelled' ? (
                    <>
                      <WarmButton
                        className={styles.compactButton}
                        onClick={() => handleStatus(task, 'done')}
                      >
                        完成
                      </WarmButton>
                      <WarmButton
                        variant="quiet"
                        className={cn(styles.compactButton, styles.dangerButton)}
                        onClick={() => handleStatus(task, 'cancelled')}
                      >
                        取消
                      </WarmButton>
                    </>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <WarmCrmRecordDrawer
        open={creating}
        onOpenChange={setCreating}
        title="新建任务"
      >
        <CrmTaskForm users={users} onSubmit={handleCreate} submitText="创建任务" />
      </WarmCrmRecordDrawer>
    </div>
  )
}
