import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskListParams, TaskStatus, TaskType } from '@/lib/crm/types'
import TasksPage from './page'

const {
  listTasks,
  setTaskStatus,
  notify,
  client,
  getRefreshHandler,
  setRefreshHandler,
  setScope,
} = vi.hoisted(() => {
  let tasks: Task[] = []
  const setState = (next: Task[]) => {
    tasks = next
  }
  const listTasks = vi.fn(async (params: TaskListParams) => {
    const type = params.type as TaskType | undefined
    const filtered = tasks.filter((t) => (type ? t.type === type : true))
    return { items: filtered, total: filtered.length, page: 1, pageSize: params.pageSize ?? 100 }
  })
  const setTaskStatus = vi.fn(async (id: string, status: TaskStatus) => {
    const task = tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在')
    const updated = { ...task, status, updatedAt: new Date().toISOString() }
    setState(tasks.map((t) => (t.id === id ? updated : t)))
    return updated
  })
  const notify = vi.fn()
  let refreshHandler: (() => void | Promise<void>) | null = null
  const setRefreshHandler = (handler: () => void | Promise<void>) => {
    refreshHandler = handler
  }
  const getRefreshHandler = () => refreshHandler
  // 稳定 client 对象（避免每次渲染新对象 → load 重建 → 无限重 fetch）
  const client = { listTasks, setTaskStatus }
  return {
    listTasks,
    setTaskStatus,
    notify,
    client,
    getRefreshHandler,
    setRefreshHandler,
    setScope: vi.fn(),
    __setTasks: setState,
    __getTasks: () => tasks,
  }
})

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    setRefreshHandler(handler)
    return { setLoading: vi.fn() }
  },
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => client,
}))
vi.mock('@/hooks/use-crm-data-scope', async () => {
  const { useState } = await import('react')
  return {
    useCrmDataScope: () => {
      const [scope, setScopeState] = useState<'mine' | 'all'>('all')
      return {
        scope,
        setScope: (next: 'mine' | 'all') => {
          setScope(next)
          setScopeState(next)
        },
        currentUserId: 'u-001',
      }
    },
  }
})
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: '测试任务',
    priority: 'medium',
    status: 'pending',
    type: 'follow_up',
    ownerId: 'u-001',
    ownerName: '张三',
    createdAt: '2026-08-01T00:00:00+00:00',
    updatedAt: '2026-08-01T00:00:00+00:00',
    ...overrides,
  }
}

const FIXTURES: Task[] = [
  makeTask({ id: 't-1', title: '确认报价单', status: 'pending', type: 'follow_up', dueDate: '2026-08-05T10:00:00+00:00' }),
  makeTask({ id: 't-2', title: '电话回访客户', status: 'in_progress', type: 'call' }),
  makeTask({ id: 't-3', title: '安排上门拜访', status: 'done', type: 'visit', completedAt: '2026-08-07T10:00:00+00:00' }),
  makeTask({ id: 't-4', title: '已取消的任务', status: 'cancelled', type: 'custom' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  ;(listTasks as ReturnType<typeof vi.fn>).mockImplementation(async (params: TaskListParams) => {
    const type = params.type as TaskType | undefined
    const filtered = FIXTURES.filter((t) => (type ? t.type === type : true))
    return { items: filtered, total: filtered.length, page: 1, pageSize: params.pageSize ?? 100 }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TasksPage', () => {
  it('看板渲染三列 + 卡片（cancelled 不入看板）', async () => {
    const { container } = render(<TasksPage />)
    expect(await screen.findByText('待办')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(await screen.findByText('确认报价单')).toBeTruthy()
    expect(screen.getByText('电话回访客户')).toBeTruthy()
    expect(screen.getByText('安排上门拜访')).toBeTruthy()
    // cancelled 不在看板
    expect(screen.queryByText('已取消的任务')).toBeNull()
    // all 视图显示负责人名
    expect(screen.getByTestId('task-owner-t-1').textContent).toContain('张三')

    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '任务工具栏' })).toBeInTheDocument()
    expect(container.querySelectorAll('[data-warm-crm-section]')).toHaveLength(3)
  })

  it('列头 type 筛选：选择后按 type 拉数并过滤卡片', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')

    fireEvent.change(screen.getByTestId('task-type-filter'), { target: { value: 'call' } })

    await waitFor(() =>
      expect(listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'call', scope: 'all' })
      )
    )
    // 仅 call 类任务保留
    await waitFor(() => expect(screen.getByText('电话回访客户')).toBeTruthy())
    expect(screen.queryByText('确认报价单')).toBeNull()
  })

  it('Head 刷新重新请求当前筛选下的任务并保留视图/筛选状态', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')
    fireEvent.change(screen.getByTestId('task-type-filter'), { target: { value: 'call' } })
    await screen.findByText('电话回访客户')
    fireEvent.click(screen.getByRole('button', { name: '列表' }))

    const callsBeforeRefresh = listTasks.mock.calls.length
    const refresh = getRefreshHandler()
    expect(refresh).toBeTypeOf('function')
    await act(async () => { await refresh?.() })

    expect(listTasks).toHaveBeenCalledTimes(callsBeforeRefresh + 1)
    expect(listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'all', type: 'call', pageSize: 100 })
    )
    expect(screen.getByTestId('task-type-filter')).toHaveValue('call')
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(await screen.findByText('电话回访客户')).toBeTruthy()
  })

  it('刷新失败时保留已有任务并显示错误', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')
    listTasks.mockRejectedValueOnce(new Error('网络不可用'))

    const refresh = getRefreshHandler()
    await act(async () => { await refresh?.() })

    expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用')
    expect(screen.getByText('确认报价单')).toBeTruthy()
  })

  it('视图切换：列表视图可见 cancelled', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')

    fireEvent.click(screen.getByRole('button', { name: '列表' }))

    expect(await screen.findByText('已取消的任务')).toBeTruthy()
    // 列表含看板任务
    expect(screen.getByText('确认报价单')).toBeTruthy()
  })

  it('看板/列表切换使用可访问的按压状态', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')

    expect(screen.getByRole('group', { name: '视图切换' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '看板' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: '列表' }))

    expect(screen.getByRole('button', { name: '看板' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('数据范围切换保留 CRM scope 并重新请求对应范围', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')

    fireEvent.click(screen.getByRole('button', { name: '我的' }))

    expect(setScope).toHaveBeenCalledWith('mine')
    await waitFor(() =>
      expect(listTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ scope: 'mine', pageSize: 100 })
      )
    )
    expect(screen.getByRole('button', { name: '我的' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
