import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CrmTaskForm } from './index'

describe('CrmTaskForm Warm layout', () => {
  it('submits the existing task input contract with defaults', async () => {
    const onSubmit = vi.fn()
    render(<CrmTaskForm users={[]} onSubmit={onSubmit} submitText="创建任务" />)

    expect(document.querySelector('[data-warm-task-form]')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('标题 *'), {
      target: { value: '确认报价单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        title: '确认报价单',
        type: 'custom',
        priority: 'medium',
        dueDate: undefined,
        description: undefined,
        ownerId: null,
      })
    )
  })

  it('normalizes an ISO due date for desktop date input and preserves it on submit', async () => {
    const onSubmit = vi.fn()
    render(
      <CrmTaskForm
        users={[]}
        initialValues={{ title: '回访客户', dueDate: '2026-08-10T10:00:00+00:00' }}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByLabelText('截止时间')).toHaveValue('2026-08-10')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ title: '回访客户', dueDate: '2026-08-10' })
      )
    )
  })
})
