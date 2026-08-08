import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmTaskTab } from './crm-task-tab'
import { NotificationsProvider } from '@/components/notifications'
import type { Task } from '@/lib/crm/types'

const tasks: Task[] = [
  {
    id: 't-1',
    title: '确认报价单',
    priority: 'high',
    status: 'pending',
    type: 'follow_up',
    ownerId: 'u-001',
    ownerName: '张三',
    customerId: 'c1',
    customerName: '客户A',
    dueDate: '2026-08-10T10:00:00+00:00',
    createdAt: '2026-08-01T00:00:00+00:00',
    updatedAt: '2026-08-01T00:00:00+00:00',
  },
  {
    id: 't-2',
    title: '已完成的任务',
    priority: 'medium',
    status: 'done',
    type: 'call',
    ownerId: 'u-001',
    ownerName: '张三',
    completedAt: '2026-08-02T10:00:00+00:00',
    createdAt: '2026-08-01T00:00:00+00:00',
    updatedAt: '2026-08-02T00:00:00+00:00',
  },
]

const { listTasks, completeTask, cancelTask, createTask, notify } = vi.hoisted(() => ({
  listTasks: vi.fn(async () => ({ items: tasks, total: tasks.length, page: 1, pageSize: 50 })),
  completeTask: vi.fn(async (id: string) => ({
    ...tasks.find((t) => t.id === id)!,
    status: 'done',
    completedAt: new Date().toISOString(),
  })),
  cancelTask: vi.fn(async (id: string) => ({
    ...tasks.find((t) => t.id === id)!,
    status: 'cancelled',
  })),
  createTask: vi.fn(async (input: unknown) => ({
    id: 't-new',
    ...(input as object),
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  notify: vi.fn(),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ listTasks, completeTask, cancelTask, createTask }),
}))
vi.mock('@/hooks/use-crm-users', () => ({
  useCrmUsers: () => [],
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function renderTab() {
  return render(
    <NotificationsProvider>
      <CrmTaskTab entityType="customer" entityId="c1" />
    </NotificationsProvider>
  )
}

describe('CrmTaskTab（抽屉任务 tab，BLF-514）', () => {
  it('加载实体关联任务并按 customerId 拉取', async () => {
    renderTab()
    expect(await screen.findByText('确认报价单')).toBeTruthy()
    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all', customerId: 'c1', pageSize: 50 })
    )
  })

  it('完成按钮调用 completeTask', async () => {
    renderTab()
    const doneBtn = (await screen.findAllByText('完成'))[0] as HTMLElement
    fireEvent.click(doneBtn)
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith('t-1'))
  })

  it('新建任务弹窗打开并提交', async () => {
    renderTab()
    fireEvent.click(await screen.findByTestId('task-tab-create'))
    // 表单标题字段
    const titleInput = await screen.findByLabelText('标题 *')
    fireEvent.change(titleInput, { target: { value: '新任务标题' } })
    const submitBtn = screen.getByRole('button', { name: '创建任务' })
    fireEvent.click(submitBtn)
    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: '新任务标题', customerId: 'c1' })
      )
    )
  })
})
