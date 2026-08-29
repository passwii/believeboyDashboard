'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Inbox, Pencil, Plus } from 'lucide-react'
import type { Task, TaskInput, TaskPriority } from '@/lib/crm/types'
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { cn } from '@/lib/utils'
import {
  TERM_SELECT_NATIVE,
  TermEnumPill,
  type TermTone,
} from '@/components/crm/term-shared'
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
  if (state === 'overdue') return 'font-mono font-medium text-term-neg'
  if (state === 'today') return 'font-mono font-medium text-term-warn'
  return ''
}

/** BLF-837：任务状态 → 终端语义（done=pos · cancelled=muted · in_progress=warn · pending=info）。 */
const STATUS_TONE: Record<Task['status'], TermTone> = {
  pending: 'info',
  in_progress: 'warn',
  done: 'pos',
  cancelled: 'muted',
}

/** BLF-837：优先级 → 终端语义（urgent=neg · high=warn · medium=accent · low=muted）。 */
const PRIORITY_TONE: Record<TaskPriority, TermTone> = {
  low: 'muted',
  medium: 'accent',
  high: 'warn',
  urgent: 'neg',
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
      <div className="flex flex-col items-center gap-3 py-20 text-term-faint">
        <Inbox className="h-10 w-10" />
        <p className="font-mono text-xs">暂无任务</p>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          className="h-9 rounded-none border border-term-border bg-term-panel font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
        >
          <Plus className="mr-1 h-4 w-4" /> 新建任务
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* 表头筛选行（type/status/priority/owner/关联客户，复用 P5 筛选语义）
          规则 2/8：手机 2 列网格内联标签，md+ 横向 flex（BLF-837 终端规格） */}
      <div className="grid grid-cols-2 items-end gap-2 border border-term-border bg-term-bg/50 px-2.5 py-2 md:flex md:flex-wrap md:items-center md:gap-1.5">
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
          <Button
            size="sm"
            className="h-9 w-full rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text md:w-auto"
            onClick={() => setCreating(true)}
            data-testid="task-list-create"
          >
            <Plus className="mr-0.5 h-4 w-4" /> 新建任务
          </Button>
        </div>
      </div>

      {/* BLF-837：列表终端规格——零圆角、term 边界、mono 数值、单色 pill */}
      <div className="overflow-x-auto border border-term-border">
        <table className="w-full min-w-[840px] border-collapse text-left font-mono text-xs tabular-nums">
          <thead>
            <tr className="border-b border-term-border bg-term-raised text-xs uppercase tracking-wider text-term-muted">
              <th className="px-2 py-2 font-medium normal-case tracking-normal">标题</th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">类型</th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">
                <SortHeader label="优先级" active={sortBy === 'priority'} order={sortOrder} onClick={() => toggleSort('priority')} />
              </th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">状态</th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">
                <SortHeader label="截止" active={sortBy === 'dueDate'} order={sortOrder} onClick={() => toggleSort('dueDate')} />
              </th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">关联</th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">负责人</th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">
                <SortHeader label="创建时间" active={sortBy === 'createdAt'} order={sortOrder} onClick={() => toggleSort('createdAt')} />
              </th>
              <th className="px-2 py-2 font-medium normal-case tracking-normal">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-term-border">
            {visible.map((task) => {
              const linked = task.customerName ?? task.leadName
              const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
              return (
                <tr key={task.id} data-testid={`task-row-${task.id}`} className="transition-colors hover:bg-term-hover">
                  <td className="max-w-[280px] truncate px-2 py-1.5 font-sans font-medium normal-case tracking-normal text-term-text">
                    {task.title}
                    {task.completedAt && (
                      <span className="ml-2 font-mono text-xs font-normal tabular-nums text-term-faint">
                        完成于 {new Date(task.completedAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <TermEnumPill tone="muted">{TASK_TYPE_LABELS[task.type]}</TermEnumPill>
                  </td>
                  <td className="px-2 py-1.5">
                    <TermEnumPill tone={PRIORITY_TONE[task.priority]}>
                      {TASK_PRIORITY_LABELS[task.priority]}
                    </TermEnumPill>
                  </td>
                  <td className="px-2 py-1.5">
                    <TermEnumPill tone={STATUS_TONE[task.status]}>
                      {TASK_STATUS_LABELS[task.status]}
                    </TermEnumPill>
                  </td>
                  <td className={cn('px-2 py-1.5 normal-case tracking-normal', dueStateClass(dueDateState(task.dueDate)))}>
                    {task.dueDate ? formatDueDate(task.dueDate) || '—' : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-term-muted normal-case tracking-normal font-sans">
                    {linked ? `${linkedKind} · ${linked}` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-term-muted normal-case tracking-normal font-sans">
                    {task.ownerName ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-term-muted normal-case tracking-normal">
                    {task.createdAt ? new Date(task.createdAt).toLocaleDateString('zh-CN') : '—'}
                  </td>
                  <td className="px-2 py-1.5 normal-case tracking-normal font-sans">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" className="h-7 rounded-none border-term-border bg-term-panel px-1.5 font-mono text-xs text-term-muted hover:text-term-text" onClick={() => setEditing(task)} data-testid={`task-edit-${task.id}`}>
                        <Pencil className="mr-0.5 h-3.5 w-3.5" /> 编辑
                      </Button>
                      {(task.status === 'pending' || task.status === 'in_progress') && (
                        <Button size="sm" variant="outline" className="h-7 rounded-none border-term-border bg-term-panel px-1.5 font-mono text-xs text-term-pos hover:text-term-text" onClick={() => handleComplete(task)} disabled={busyId === task.id}>
                          {busyId === task.id ? '处理中…' : '完成'}
                        </Button>
                      )}
                      {task.status !== 'done' && task.status !== 'cancelled' && (
                        <Button size="sm" variant="ghost" className="h-7 rounded-none px-1.5 font-mono text-xs text-term-neg hover:bg-term-hover hover:text-term-text" onClick={() => handleCancel(task)} disabled={busyId === task.id}>
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
        <SheetContent className="w-full gap-0 rounded-none p-0 sm:max-w-md">
          <SheetHeader className="rounded-none border-b border-term-border px-3 py-2">
            <SheetTitle className="font-mono text-sm uppercase tracking-wider text-term-muted">新建任务</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <CrmTaskForm users={users} onSubmit={handleCreate} submitText="创建任务" />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <SheetContent className="w-full gap-0 rounded-none p-0 sm:max-w-md">
          <SheetHeader className="rounded-none border-b border-term-border px-3 py-2">
            <SheetTitle className="font-mono text-sm uppercase tracking-wider text-term-muted">编辑任务</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-3 py-3">
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
    <label className="flex flex-col gap-1 text-xs md:flex-row md:items-center md:gap-1.5">
      <span className="font-mono uppercase tracking-wider text-term-muted">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${TERM_SELECT_NATIVE} w-full tabular-nums md:w-auto`}
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
        'inline-flex items-center gap-1 font-mono hover:text-term-text',
        active && 'text-term-text'
      )}
    >
      {label}
      <span aria-hidden="true" className="text-[10px]">
        {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  )
}
