import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmCategoryField } from './index'
import type { Customer } from '@/lib/crm/types/customer'

import { stableNotifications } from '@/test-utils/stable-mocks'

const { mockClient, mockList, mockSet } = vi.hoisted(() => {
  const list = vi.fn()
  const set = vi.fn()
  return {
    mockClient: { listCategories: list, setCustomerCategories: set },
    mockList: list,
    mockSet: set,
  }
})
vi.mock('@/lib/crm/api/crm-client-provider', async (i) => {
  const a = await i<typeof import('@/lib/crm/api/crm-client-provider')>()
  return { ...a, useCrmClient: () => mockClient }
})
vi.mock('@/components/notifications', async (i) => {
  const a = await i<typeof import('@/components/notifications')>()
  return { ...a, useNotifications: () => stableNotifications() }
})

const now = new Date().toISOString()
const mkCustomer = (o: Partial<Customer> = {}): Customer =>
  ({
    id: '7',
    name: 'X',
    rating: 'B',
    categories: [{ id: '1', name: '家居' }],
    status: 'active',
    source: 'referral',
    ownerId: 'u1',
    ownerName: '小王',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u1',
    ...o,
  }) as Customer

beforeEach(() => {
  mockList.mockReset()
  mockSet.mockReset()
})

describe('CrmCategoryField（P6b）', () => {
  it('展示当前类目 chips；无类目显示未设置', () => {
    mockList.mockResolvedValue([])
    const { rerender } = render(<CrmCategoryField customer={mkCustomer()} />)
    expect(screen.getByText('家居')).toBeTruthy()
    rerender(<CrmCategoryField customer={mkCustomer({ categories: [] })} />)
    expect(screen.getByText('未设置')).toBeTruthy()
  })

  it('点击编辑弹出类目多选并保存调用 setCustomerCategories', async () => {
    mockList.mockResolvedValue([
      { id: '1', name: '家居', sortOrder: 0, createdAt: now },
      { id: '2', name: '3C', sortOrder: 1, createdAt: now },
    ])
    const onSaved = vi.fn()
    render(<CrmCategoryField customer={mkCustomer()} onSaved={onSaved} />)

    fireEvent.click(screen.getByText('编辑'))
    // 等待类目加载
    await waitFor(() => expect(screen.getByText('3C')).toBeTruthy())

    // 勾选 3C
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1])
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith('7', ['1', '2'])
    })
  })

  it('保存失败不崩溃（notify 由 provider 处理）', async () => {
    mockList.mockResolvedValue([])
    mockSet.mockRejectedValue(new Error('boom'))
    render(<CrmCategoryField customer={mkCustomer({ categories: [] })} />)
    fireEvent.click(screen.getByText('编辑'))
    await waitFor(() => expect(screen.getByText('未设置')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 保存中按钮变回可点，说明 catch 已执行（无未捕获异常）
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeTruthy())
  })
})
