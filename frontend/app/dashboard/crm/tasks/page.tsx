'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KanbanSquare, List } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import type { Task, TaskType } from '@/lib/crm/types'
import { TASK_TYPE_LABELS } from '@/lib/crm/enums/task.enum'
import { ScopeToggle } from '../customers/components/scope-toggle'
import { TERM_SELECT_NATIVE } from '@/components/crm/term-shared'
import { TaskKanban } from './components/task-kanban'
import { TaskList } from './components/task-list'
import { createDragEndHandler } from './board'

const PAGE_SIZE = 100

type ViewMode = 'board' | 'list'
type TypeFilter = 'all' | TaskType

const TASK_TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'follow_up', label: '跟进' },
  { value: 'call', label: '电话' },
  { value: 'visit', label: '拜访' },
  { value: 'custom', label: '自定义' },
]

export default function TasksPage() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()

  const [view, setView] = useState<ViewMode>('board')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await client.listTasks({
        scope,
        type: typeFilter === 'all' ? undefined : typeFilter,
        pageSize: PAGE_SIZE,
      })
      setTasks(page.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载任务失败')
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [client, scope, typeFilter])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const onError = useCallback(
    (message: string) => {
      notify({ type: 'error', title: '状态更新失败', message })
    },
    [notify]
  )

  const handleDragEnd = useMemo(
    () => createDragEndHandler(tasks, setTasks, { setTaskStatus: client.setTaskStatus, onError }),
    [tasks, client.setTaskStatus, onError]
  )

  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载；工具行终端控件
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        {/* 列头 type 筛选（设计 §8.2：看板可按 type 过滤） */}
        <select
          aria-label="按类型筛选"
          data-testid="task-type-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          className={TERM_SELECT_NATIVE}
        >
          {TASK_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {/* 看板 / 列表双视图切换（终端 Tab） */}
        <div
          role="radiogroup"
          aria-label="视图切换"
          className="inline-flex items-center rounded-none border border-term-border bg-term-bg p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={view === 'board'}
            data-testid="view-board"
            onClick={() => setView('board')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 font-mono text-xs transition-colors',
              view === 'board'
                ? 'bg-term-raised text-term-text'
                : 'text-term-muted hover:text-term-text'
            )}
          >
            <KanbanSquare className="h-4 w-4" />
            看板
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === 'list'}
            data-testid="view-list"
            onClick={() => setView('list')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 font-mono text-xs transition-colors',
              view === 'list'
                ? 'bg-term-raised text-term-text'
                : 'text-term-muted hover:text-term-text'
            )}
          >
            <List className="h-4 w-4" />
            列表
          </button>
        </div>
        <ScopeToggle />
      </div>

      {loading && tasks.length === 0 ? (
        <div className="py-16 text-center font-mono text-xs text-term-faint">加载中…</div>
      ) : error ? (
        <div
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          ERR · {error}
        </div>
      ) : view === 'board' ? (
        <TaskKanban tasks={tasks} onDragEnd={handleDragEnd} showOwner={scope === 'all'} />
      ) : (
        <TaskList tasks={tasks} />
      )}
    </div>
  )
}
