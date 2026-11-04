import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/lib/crm/types'
import { TaskList } from './task-list'

const { completeTask, cancelTask, createTask, updateTask, notify } = vi.hoisted(() => ({
  completeTask: vi.fn(),
  cancelTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ completeTask, cancelTask, createTask, updateTask }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
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
    createdAt: '2026-08-01T10:00:00+00:00',
    updatedAt: '2026-08-01T10:00:00+00:00',
    ...overrides,
  }
}

const FIXTURES: Task[] = [
  makeTask(),
  makeTask({
    id: 't-2',
    title: '安排上门拜访',
    status: 'done',
    type: 'visit',
    completedAt: '2026-08-02T10:00:00+00:00',
  }),
  makeTask({
    id: 't-3',
    title: '回访未成交客户',
    status: 'pending',
    type: 'call',
  }),
]

function renderList() {
  return render(<TaskList tasks={FIXTURES} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  completeTask.mockImplementation(async (id: string) => ({
    ...FIXTURES.find((task) => task.id === id)!,
    status: 'done',
    completedAt: '2026-08-03T10:00:00+00:00',
  }))
  cancelTask.mockImplementation(async (id: string) => ({
    ...FIXTURES.find((task) => task.id === id)!,
    status: 'cancelled',
  }))
  createTask.mockImplementation(async (input: object) => ({
    ...makeTask(),
    id: 't-new',
    ...input,
  }))
  updateTask.mockImplementation(async (id: string, input: object) => ({
    ...FIXTURES.find((task) => task.id === id)!,
    ...input,
  }))
})

afterEach(() => {
  document.getElementById('warm-ledger-portal-root')?.remove()
})

describe('TaskList Warm view behavior', () => {
  it('keeps local filters and renders the Warm table frame', () => {
    const { container } = renderList()

    expect(container.querySelector('[data-warm-crm-table-frame]')).toBeInTheDocument()
    expect(screen.getByTestId('task-row-t-1')).toBeInTheDocument()
    expect(screen.getByTestId('task-row-t-2')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'done' } })

    expect(screen.queryByTestId('task-row-t-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-row-t-2')).toBeInTheDocument()
  })

  it('completes and cancels rows through the existing client calls', async () => {
    renderList()

    fireEvent.click(within(screen.getByTestId('task-row-t-1')).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(completeTask).toHaveBeenCalledWith('t-1'))

    fireEvent.click(within(screen.getByTestId('task-row-t-3')).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t-3'))
  })

  it('creates a task from the Warm drawer', async () => {
    renderList()

    fireEvent.click(screen.getByTestId('task-list-create'))
    const dialog = await screen.findByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByLabelText('标题 *'), {
      target: { value: '新任务标题' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: '新任务标题', type: 'custom', priority: 'medium' })
      )
    )
  })

  it('edits a task with the existing initial values', async () => {
    renderList()

    fireEvent.click(screen.getByTestId('task-edit-t-1'))
    const dialog = await screen.findByRole('dialog', { name: '编辑任务' })
    const titleInput = within(dialog).getByLabelText('标题 *')
    expect(titleInput).toHaveValue('确认报价单')
    expect(within(dialog).getByLabelText('截止时间')).toHaveValue('2026-08-10')

    fireEvent.change(titleInput, { target: { value: '修改后的任务' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }))

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({ title: '修改后的任务', dueDate: '2026-08-10' })
      )
    )
  })
})
