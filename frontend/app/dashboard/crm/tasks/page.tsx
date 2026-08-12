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
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">任务</h1>
          <p className="text-sm text-muted-foreground">
            拖拽卡片到目标列即可流转状态；已取消任务在列表视图可见
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 列头 type 筛选（设计 §8.2：看板可按 type 过滤） */}
          <select
            aria-label="按类型筛选"
            data-testid="task-type-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="h-9 rounded-md border border-border/60 bg-background px-2.5 text-sm shadow-sm focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20"
          >
            {TASK_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {/* 看板 / 列表双视图切换 */}
          <div
            role="radiogroup"
            aria-label="视图切换"
            className="inline-flex rounded-md border border-border/60 bg-background p-0.5 text-sm shadow-sm"
          >
            <button
              type="button"
              role="radio"
              aria-checked={view === 'board'}
              data-testid="view-board"
              onClick={() => setView('board')}
              className={cn(
                'flex items-center gap-1 rounded px-3 py-1.5 transition-colors',
                view === 'board'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
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
                'flex items-center gap-1 rounded px-3 py-1.5 transition-colors',
                view === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <List className="h-4 w-4" />
              列表
            </button>
          </div>
          <ScopeToggle />
        </div>
      </div>

      {loading && tasks.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
      ) : error ? (
        <div className="py-16 text-center text-sm text-rose-600">{error}</div>
      ) : view === 'board' ? (
        <TaskKanban tasks={tasks} onDragEnd={handleDragEnd} showOwner={scope === 'all'} />
      ) : (
        <TaskList tasks={tasks} />
      )}
    </div>
  )
}
