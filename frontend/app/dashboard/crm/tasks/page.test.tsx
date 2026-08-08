import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskListParams, TaskStatus, TaskType } from '@/lib/crm/types'
import TasksPage from './page'

const { listTasks, setTaskStatus, notify, client } = vi.hoisted(() => {
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
  // 稳定 client 对象（避免每次渲染新对象 → load 重建 → 无限重 fetch）
  const client = { listTasks, setTaskStatus }
  return { listTasks, setTaskStatus, notify, client, __setTasks: setState, __getTasks: () => tasks }
})

vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => client,
}))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'u-001' }),
}))
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
    render(<TasksPage />)
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

  it('视图切换：列表视图可见 cancelled', async () => {
    render(<TasksPage />)
    await screen.findByText('确认报价单')

    fireEvent.click(screen.getByTestId('view-list'))

    expect(await screen.findByText('已取消的任务')).toBeTruthy()
    // 列表含看板任务
    expect(screen.getByText('确认报价单')).toBeTruthy()
  })
})
