'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  WarmCrmPage,
  WarmCrmState,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import {
  WarmButton,
  WarmSegmentedControl,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope, type CrmDataScope } from '@/hooks/use-crm-data-scope'
import { useNotifications } from '@/components/notifications'
import type { Task, TaskType } from '@/lib/crm/types'
import { TaskKanban } from './components/task-kanban'
import { TaskList } from './components/task-list'
import { createDragEndHandler } from './board'
import styles from './page.module.css'

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

const VIEW_OPTIONS: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: 'board', label: '看板' },
  { value: 'list', label: '列表' },
]

const SCOPE_OPTIONS: ReadonlyArray<{ value: CrmDataScope; label: string }> = [
  { value: 'mine', label: '我的' },
  { value: 'all', label: '全部' },
]

export default function TasksPage() {
  const client = useCrmClient()
  const { scope, setScope } = useCrmDataScope()
  const { notify } = useNotifications()

  const [view, setView] = useState<ViewMode>('board')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (preserveData = false) => {
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
        if (!preserveData) setTasks([])
      } finally {
        setLoading(false)
      }
    },
    [client, scope, typeFilter]
  )

  useHeaderRefresh(() => load(true), { loading })

  useEffect(() => {
    void load()
  }, [load])

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
    <WarmCrmPage aria-busy={loading || undefined}>
      <WarmCrmToolbar
        ariaLabel="任务工具栏"
        start={
          <select
            aria-label="按类型筛选"
            data-testid="task-type-filter"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
            className={styles.select}
          >
            {TASK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
        end={
          <div className={styles.toolbarControls}>
            <WarmSegmentedControl
              ariaLabel="视图切换"
              value={view}
              options={VIEW_OPTIONS}
              onChange={setView}
            />
            <WarmSegmentedControl
              ariaLabel="数据范围"
              value={scope}
              options={SCOPE_OPTIONS}
              onChange={setScope}
            />
          </div>
        }
      />

      {loading && tasks.length === 0 ? (
        <WarmCrmState kind="loading" title="任务加载中" />
      ) : (
        <>
          {error ? (
            <WarmCrmState
              kind="error"
              title="加载任务失败"
              detail={error}
              action={
                <WarmButton onClick={() => void load(tasks.length > 0)}>重试</WarmButton>
              }
            />
          ) : null}

          {(!error || tasks.length > 0) &&
            (view === 'board' ? (
              <TaskKanban tasks={tasks} onDragEnd={handleDragEnd} showOwner={scope === 'all'} />
            ) : (
              <TaskList tasks={tasks} />
            ))}
        </>
      )}
    </WarmCrmPage>
  )
}
