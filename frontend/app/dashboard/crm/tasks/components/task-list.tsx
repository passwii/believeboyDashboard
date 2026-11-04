'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import type { Task, TaskInput, TaskPriority } from '@/lib/crm/types'
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { useNotifications } from '@/components/notifications'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsersSafe } from '@/hooks/use-crm-users'
import {
  WarmCrmRecordDrawer,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
  WarmCrmToolbar,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { CrmTaskForm } from '@/components/crm/crm-task-form'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate, type DueState } from '../task-utils'
import styles from './task-list.module.css'

/** 优先级权重（后端 _PRIORITY_RANK：urgent > high > medium > low）。 */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
}

type SortField = 'dueDate' | 'priority' | 'createdAt'
type SortOrder = 'asc' | 'desc'

const STATUS_TONE: Record<Task['status'], WarmCrmStatusTone> = {
  pending: 'accent',
  in_progress: 'accent',
  done: 'positive',
  cancelled: 'neutral',
}

const PRIORITY_TONE: Record<TaskPriority, WarmCrmStatusTone> = {
  low: 'neutral',
  medium: 'accent',
  high: 'accent',
  urgent: 'negative',
}

export interface TaskListFilter {
  type: string
  status: string
  priority: string
  ownerId: string
  customerId: string
}

export const EMPTY_TASK_FILTER: TaskListFilter = {
  type: '',
  status: '',
  priority: '',
  ownerId: '',
  customerId: '',
}

/** 客户端筛选（type/status/priority/owner/关联客户），与后端筛选语义对齐。 */
export function filterTasks(tasks: Task[], filters: TaskListFilter): Task[] {
  return tasks.filter((task) => {
    if (filters.type && task.type !== filters.type) return false
    if (filters.status && task.status !== filters.status) return false
    if (filters.priority && task.priority !== filters.priority) return false
    if (filters.ownerId && task.ownerId !== filters.ownerId) return false
    if (filters.customerId) {
      if (filters.customerId.startsWith('lead:')) {
        if (task.leadId !== filters.customerId.slice(5)) return false
      } else if (task.customerId !== filters.customerId) {
        return false
      }
    }
    return true
  })
}

/** 客户端排序（截止升序 nulls last / 优先级权重 / 创建时间）。 */
export function sortTasks(tasks: Task[], sortBy: SortField, sortOrder: SortOrder): Task[] {
  const direction = sortOrder === 'desc' ? -1 : 1
  return [...tasks].sort((a, b) => {
    let comparison = 0
    if (sortBy === 'dueDate') {
      const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY
      const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY
      comparison = dueA === dueB ? 0 : dueA < dueB ? -1 : 1
    } else if (sortBy === 'priority') {
      comparison = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    } else {
      comparison = a.createdAt.localeCompare(b.createdAt)
    }
    if (comparison !== 0) return comparison * direction
    return a.id.localeCompare(b.id)
  })
}

/**
 * 任务列表视图：表头筛选、排序、编辑/完成/取消。
 * 页面级 tasks 仍是数据源，所有写操作与本地筛选语义保持不变。
 */
export function TaskList({ tasks }: { tasks: Task[] }) {
  const client = useCrmClient()
  const users = useCrmUsersSafe()
  const { notify } = useNotifications()

  const [rows, setRows] = useState<Task[]>(tasks)
  useEffect(() => setRows(tasks), [tasks])

  const [filters, setFilters] = useState<TaskListFilter>(EMPTY_TASK_FILTER)
  const [sortBy, setSortBy] = useState<SortField>('dueDate')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)

  const setFilter = (key: keyof TaskListFilter) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }))

  const toggleSort = (field: SortField) => {
    if (sortBy !== field) {
      setSortBy(field)
      setSortOrder('asc')
    } else if (sortOrder === 'asc') {
      setSortOrder('desc')
    } else {
      setSortBy('dueDate')
      setSortOrder('asc')
    }
  }

  const ownerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of rows) {
      if (task.ownerId && task.ownerName) map.set(task.ownerId, task.ownerName)
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [rows])

  const customerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of rows) {
      if (task.customerId && task.customerName) {
        map.set(task.customerId, task.customerName)
      } else if (task.leadId && task.leadName) {
        map.set(`lead:${task.leadId}`, `${task.leadName}（线索）`)
      }
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [rows])

  const visible = useMemo(
    () => sortTasks(filterTasks(rows, filters), sortBy, sortOrder),
    [rows, filters, sortBy, sortOrder]
  )

  const replaceRow = useCallback((updated: Task) => {
    setRows((current) => current.map((task) => (task.id === updated.id ? updated : task)))
  }, [])

  async function handleComplete(task: Task) {
    setBusyId(task.id)
    try {
      const updated = await client.completeTask(task.id)
      replaceRow(updated)
      notify({ type: 'success', title: '任务已完成' })
    } catch (error) {
      notify({
        type: 'error',
        title: '操作失败',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyId(null)
    }
  }

  async function handleCancel(task: Task) {
    setBusyId(task.id)
    try {
      const updated = await client.cancelTask(task.id)
      replaceRow(updated)
      notify({ type: 'success', title: '任务已取消' })
    } catch (error) {
      notify({
        type: 'error',
        title: '操作失败',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyId(null)
    }
  }

  async function handleEditSave(input: TaskInput) {
    if (!editing) return
    const updated = await client.updateTask(editing.id, input)
    replaceRow(updated)
    notify({ type: 'success', title: '任务已更新' })
    setEditing(null)
  }

  async function handleCreate(input: TaskInput) {
    const created = await client.createTask(input)
    setRows((current) => [created, ...current])
    notify({ type: 'success', title: '任务已创建' })
    setCreating(false)
  }

  if (rows.length === 0 && !creating) {
    return (
      <WarmCrmState
        kind="empty"
        title="暂无任务"
        action={
          <WarmButton onClick={() => setCreating(true)} data-testid="task-list-create">
            <Plus aria-hidden="true" className={styles.actionIcon} />
            新建任务
          </WarmButton>
        }
      />
    )
  }

  return (
    <div className={styles.root}>
      <WarmCrmToolbar
        ariaLabel="任务筛选工具栏"
        start={
          <div className={styles.filters}>
            <FilterSelect
              label="类型"
              value={filters.type}
              onChange={setFilter('type')}
              options={Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <FilterSelect
              label="状态"
              value={filters.status}
              onChange={setFilter('status')}
              options={Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <FilterSelect
              label="优先级"
              value={filters.priority}
              onChange={setFilter('priority')}
              options={Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <FilterSelect
              label="负责人"
              value={filters.ownerId}
              onChange={setFilter('ownerId')}
              options={ownerOptions}
            />
            <FilterSelect
              label="关联客户"
              value={filters.customerId}
              onChange={setFilter('customerId')}
              options={customerOptions}
            />
          </div>
        }
        end={
          <WarmButton
            variant="primary"
            onClick={() => setCreating(true)}
            data-testid="task-list-create"
          >
            <Plus aria-hidden="true" className={styles.actionIcon} />
            新建任务
          </WarmButton>
        }
      />

      <WarmCrmTableFrame>
        <WarmCrmTableScroller ariaLabel="任务列表">
          <table className={styles.table}>
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th aria-sort={ariaSort('priority', sortBy, sortOrder)}>
                  <SortHeader
                    label="优先级"
                    active={sortBy === 'priority'}
                    order={sortOrder}
                    onClick={() => toggleSort('priority')}
                  />
                </th>
                <th>状态</th>
                <th aria-sort={ariaSort('dueDate', sortBy, sortOrder)}>
                  <SortHeader
                    label="截止"
                    active={sortBy === 'dueDate'}
                    order={sortOrder}
                    onClick={() => toggleSort('dueDate')}
                  />
                </th>
                <th>关联</th>
                <th>负责人</th>
                <th aria-sort={ariaSort('createdAt', sortBy, sortOrder)}>
                  <SortHeader
                    label="创建时间"
                    active={sortBy === 'createdAt'}
                    order={sortOrder}
                    onClick={() => toggleSort('createdAt')}
                  />
                </th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const linked = task.customerName ?? task.leadName
                const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
                const due = dueDateState(task.dueDate)
                return (
                  <tr key={task.id} data-testid={`task-row-${task.id}`}>
                    <td className={styles.titleCell}>
                      <span className={styles.taskTitle}>{task.title}</span>
                      {task.completedAt ? (
                        <span className={styles.completed}>
                          完成于 {new Date(task.completedAt).toLocaleDateString('zh-CN')}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <WarmCrmStatusPill tone="neutral">
                        {TASK_TYPE_LABELS[task.type]}
                      </WarmCrmStatusPill>
                    </td>
                    <td>
                      <WarmCrmStatusPill tone={PRIORITY_TONE[task.priority]}>
                        {TASK_PRIORITY_LABELS[task.priority]}
                      </WarmCrmStatusPill>
                    </td>
                    <td>
                      <WarmCrmStatusPill tone={STATUS_TONE[task.status]}>
                        {TASK_STATUS_LABELS[task.status]}
                      </WarmCrmStatusPill>
                    </td>
                    <td className={dueStateClass(due)}>
                      {task.dueDate ? formatDueDate(task.dueDate) || '—' : '—'}
                    </td>
                    <td className={styles.secondaryCell}>
                      {linked ? `${linkedKind} · ${linked}` : '—'}
                    </td>
                    <td className={styles.secondaryCell}>{task.ownerName ?? '—'}</td>
                    <td className={styles.dateCell}>
                      {task.createdAt ? new Date(task.createdAt).toLocaleDateString('zh-CN') : '—'}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <WarmButton
                          variant="quiet"
                          className={styles.rowButton}
                          onClick={() => setEditing(task)}
                          data-testid={`task-edit-${task.id}`}
                        >
                          <Pencil aria-hidden="true" className={styles.rowIcon} />
                          编辑
                        </WarmButton>
                        {(task.status === 'pending' || task.status === 'in_progress') && (
                          <WarmButton
                            className={styles.rowButton}
                            onClick={() => handleComplete(task)}
                            disabled={busyId === task.id}
                          >
                            {busyId === task.id ? '处理中…' : '完成'}
                          </WarmButton>
                        )}
                        {task.status !== 'done' && task.status !== 'cancelled' && (
                          <WarmButton
                            variant="quiet"
                            className={cn(styles.rowButton, styles.dangerButton)}
                            onClick={() => handleCancel(task)}
                            disabled={busyId === task.id}
                          >
                            取消
                          </WarmButton>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </WarmCrmTableScroller>
      </WarmCrmTableFrame>

      <WarmCrmRecordDrawer open={creating} onOpenChange={setCreating} title="新建任务">
        <CrmTaskForm users={users} onSubmit={handleCreate} submitText="创建任务" />
      </WarmCrmRecordDrawer>

      <WarmCrmRecordDrawer
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        title="编辑任务"
      >
        {editing ? (
          <CrmTaskForm
            users={users}
            initialValues={{
              title: editing.title,
              type: editing.type,
              priority: editing.priority,
              dueDate: editing.dueDate ?? '',
              description: editing.description ?? '',
              ownerId: editing.ownerId,
            }}
            onSubmit={handleEditSave}
            submitText="保存修改"
          />
        ) : null}
      </WarmCrmRecordDrawer>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className={styles.filter}>
      <span className={styles.filterLabel}>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={styles.select}
      >
        <option value="">全部</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function SortHeader({
  label,
  active,
  order,
  onClick,
}: {
  label: string
  active: boolean
  order: SortOrder
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(styles.sortButton, active && styles.sortButtonActive)}
    >
      {label}
      <span aria-hidden="true" className={styles.sortIcon}>
        {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  )
}

function ariaSort(
  field: SortField,
  sortBy: SortField,
  order: SortOrder
): 'none' | 'ascending' | 'descending' {
  if (sortBy !== field) return 'none'
  return order === 'asc' ? 'ascending' : 'descending'
}

function dueStateClass(state: DueState): string {
  if (state === 'overdue') return cn(styles.dueCell, styles.dueOverdue)
  if (state === 'today') return cn(styles.dueCell, styles.dueToday)
  return styles.dueCell
}
