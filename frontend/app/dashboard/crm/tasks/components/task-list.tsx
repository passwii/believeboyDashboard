'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Inbox, Pencil, Plus } from 'lucide-react'
import type { Task, TaskInput, TaskPriority } from '@/lib/crm/types'
import {
  TASK_PRIORITY_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS,
  TASK_TYPE_COLORS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { cn } from '@/lib/utils'
import { dueDateState, formatDueDate, type DueState } from '../task-utils'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { CrmTaskForm } from '@/components/crm/crm-task-form'
import type { User } from '@/lib/crm/types'

/**
 * 安全读用户列表：测试环境（无 CrmUsersProvider）降级为空数组，
 * 避免看板页测试在列表视图炸掉（BLF-512 page.test 未 mock use-crm-users）。
 */
function useUsersSafe(): User[] {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 无条件调用，仅捕获抛错
    return useCrmUsers()
  } catch {
    return []
  }
}

/** 优先级权重（后端 _PRIORITY_RANK：urgent > high > medium > low）。 */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
}

type SortField = 'dueDate' | 'priority' | 'createdAt'
type SortOrder = 'asc' | 'desc'

function dueStateClass(state: DueState): string {
  if (state === 'overdue') return 'text-rose-600 dark:text-rose-400'
  if (state === 'today') return 'text-amber-600 dark:text-amber-400'
  return ''
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

/** 客户端筛选（type/status/priority/owner/关联客户），与后端筛选语义对齐（P5 基建）。 */
export function filterTasks(tasks: Task[], filters: TaskListFilter): Task[] {
  return tasks.filter((t) => {
    if (filters.type && t.type !== filters.type) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.priority && t.priority !== filters.priority) return false
    if (filters.ownerId && t.ownerId !== filters.ownerId) return false
    if (filters.customerId) {
      // 关联客户筛选：客户 id 直接比；线索用 "lead:" 前缀区分
      if (filters.customerId.startsWith('lead:')) {
        if (t.leadId !== filters.customerId.slice(5)) return false
      } else if (t.customerId !== filters.customerId) {
        return false
      }
    }
    return true
  })
}

/** 客户端排序（截止升序 nulls last / 优先级权重 / 创建时间），与后端排序语义一致。 */
export function sortTasks(tasks: Task[], sortBy: SortField, sortOrder: SortOrder): Task[] {
  const dir = sortOrder === 'desc' ? -1 : 1
  return [...tasks].sort((a, b) => {
    let cmp = 0
    if (sortBy === 'dueDate') {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY
      cmp = da === db ? 0 : da < db ? -1 : 1
    } else if (sortBy === 'priority') {
      cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    } else {
      cmp = a.createdAt.localeCompare(b.createdAt)
    }
    if (cmp !== 0) return cmp * dir
    return a.id.localeCompare(b.id)
  })
}

/**
 * 任务列表视图（P7，BLF-514 列表完整化）：
 * 表头筛选行（type/status/priority/owner/关联客户）+ 排序（截止/优先级/创建时间）
 * + 行操作 编辑/完成/取消；完成后显示 completed_at。
 * 与 BLF-512 看板页衔接：接收页级已拉取 tasks（pageSize=100），客户端筛选/排序。
 */
export function TaskList({ tasks }: { tasks: Task[] }) {
  const client = useCrmClient()
  const users = useUsersSafe()
  const { notify } = useNotifications()

  // 页级 tasks 作为数据源（页面负责拉取）；行操作后本地更新（乐观 + 服务端结果校正）
  const [rows, setRows] = useState<Task[]>(tasks)
  useEffect(() => setRows(tasks), [tasks])

  const [filters, setFilters] = useState<TaskListFilter>(EMPTY_TASK_FILTER)
  const [sortBy, setSortBy] = useState<SortField>('dueDate')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)

  const setFilter = (key: keyof TaskListFilter) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }))

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

  // 筛选选项：从当前数据派生（owner/关联客户），避免额外请求
  const ownerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of rows) {
      if (t.ownerId && t.ownerName) map.set(t.ownerId, t.ownerName)
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [rows])
  const customerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of rows) {
      if (t.customerId && t.customerName) map.set(t.customerId, t.customerName)
      else if (t.leadId && t.leadName) map.set(`lead:${t.leadId}`, `${t.leadName}（线索）`)
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }))
  }, [rows])

  const visible = useMemo(
    () => sortTasks(filterTasks(rows, filters), sortBy, sortOrder),
    [rows, filters, sortBy, sortOrder]
  )

  const replaceRow = useCallback((updated: Task) => {
    setRows((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }, [])

  async function handleComplete(task: Task) {
    setBusyId(task.id)
    try {
      const updated = await client.completeTask(task.id)
      replaceRow(updated)
      notify({ type: 'success', title: '任务已完成' })
    } catch (e) {
      notify({ type: 'error', title: '操作失败', message: e instanceof Error ? e.message : String(e) })
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
    } catch (e) {
      notify({ type: 'error', title: '操作失败', message: e instanceof Error ? e.message : String(e) })
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
    setRows((prev) => [created, ...prev])
    notify({ type: 'success', title: '任务已创建' })
    setCreating(false)
  }

  if (rows.length === 0 && !creating) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
        <Inbox className="h-10 w-10" />
        <p className="text-sm">暂无任务</p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> 新建任务
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 表头筛选行（type/status/priority/owner/关联客户，复用 P5 筛选语义）
          规则 2/8：手机 2 列网格内联标签，md+ 横向 flex */}
      <div className="grid grid-cols-2 items-end gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 shadow-sm md:flex md:flex-wrap md:items-center md:gap-3">
        <FilterSelect
          label="类型"
          value={filters.type}
          onChange={setFilter('type')}
          options={Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="状态"
          value={filters.status}
          onChange={setFilter('status')}
          options={Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="优先级"
          value={filters.priority}
          onChange={setFilter('priority')}
          options={Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => ({ value, label }))}
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
        <div className="col-span-2 md:ml-auto">
          <Button size="sm" className="w-full md:w-auto" onClick={() => setCreating(true)} data-testid="task-list-create">
            <Plus className="mr-1 h-4 w-4" /> 新建任务
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/60 bg-card">
        <table className="w-full min-w-[840px] text-left text-sm">
          <thead>
            <tr className="border-b border-border/60 text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">标题</th>
              <th className="px-4 py-2.5 font-medium">类型</th>
              <th className="px-4 py-2.5 font-medium">
                <SortHeader label="优先级" active={sortBy === 'priority'} order={sortOrder} onClick={() => toggleSort('priority')} />
              </th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">
                <SortHeader label="截止" active={sortBy === 'dueDate'} order={sortOrder} onClick={() => toggleSort('dueDate')} />
              </th>
              <th className="px-4 py-2.5 font-medium">关联</th>
              <th className="px-4 py-2.5 font-medium">负责人</th>
              <th className="px-4 py-2.5 font-medium">
                <SortHeader label="创建时间" active={sortBy === 'createdAt'} order={sortOrder} onClick={() => toggleSort('createdAt')} />
              </th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.map((task) => {
              const linked = task.customerName ?? task.leadName
              const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
              return (
                <tr key={task.id} data-testid={`task-row-${task.id}`} className="hover:bg-muted/40">
                  <td className="max-w-[280px] truncate px-4 py-2.5 font-medium text-foreground">
                    {task.title}
                    {task.completedAt && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        完成于 {new Date(task.completedAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant="outline" className={cn('px-1.5 py-0 text-[11px]', TASK_TYPE_COLORS[task.type])}>
                      {TASK_TYPE_LABELS[task.type]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px]', TASK_PRIORITY_COLORS[task.priority])}>
                      {TASK_PRIORITY_LABELS[task.priority]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px]', TASK_STATUS_COLORS[task.status])}>
                      {TASK_STATUS_LABELS[task.status]}
                    </Badge>
                  </td>
                  <td className={cn('px-4 py-2.5', dueStateClass(dueDateState(task.dueDate)))}>
                    {task.dueDate ? formatDueDate(task.dueDate) || '—' : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {linked ? `${linkedKind} · ${linked}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{task.ownerName ?? '—'}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {task.createdAt ? new Date(task.createdAt).toLocaleDateString('zh-CN') : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setEditing(task)} data-testid={`task-edit-${task.id}`}>
                        <Pencil className="mr-1 h-3.5 w-3.5" /> 编辑
                      </Button>
                      {(task.status === 'pending' || task.status === 'in_progress') && (
                        <Button size="sm" variant="outline" onClick={() => handleComplete(task)} disabled={busyId === task.id}>
                          {busyId === task.id ? '处理中…' : '完成'}
                        </Button>
                      )}
                      {task.status !== 'done' && task.status !== 'cancelled' && (
                        <Button size="sm" variant="ghost" onClick={() => handleCancel(task)} disabled={busyId === task.id}>
                          取消
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 新建 / 编辑复用同一表单组件 */}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b border-border/60 px-5 py-4">
            <SheetTitle>新建任务</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <CrmTaskForm users={users} onSubmit={handleCreate} submitText="创建任务" />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b border-border/60 px-5 py-4">
            <SheetTitle>编辑任务</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {editing && (
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
            )}
          </div>
        </SheetContent>
      </Sheet>
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
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm md:flex-row md:items-center md:gap-1.5">
      <span className="text-xs text-muted-foreground md:text-sm">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm md:h-8 md:w-auto"
      >
        <option value="">全部</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
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
      className={cn(
        'inline-flex items-center gap-1 font-medium hover:text-foreground',
        active && 'text-foreground'
      )}
    >
      {label}
      <span aria-hidden="true" className="text-[10px]">
        {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  )
}
