import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmCategoryManager } from './index'

import { stableNotifications } from '@/test-utils/stable-mocks'


const { mockClient, mockList, mockCreate, mockUpdate, mockDelete } = vi.hoisted(
  () => {
    const list = vi.fn()
    const create = vi.fn()
    const update = vi.fn()
    const del = vi.fn()
    return {
      mockClient: {
        listCategories: list,
        createCategory: create,
        updateCategory: update,
        deleteCategory: del,
      },
      mockList: list,
      mockCreate: create,
      mockUpdate: update,
      mockDelete: del,
    }
  }
)
vi.mock('@/lib/crm/api/crm-client-provider', async (i) => {
  const a = await i<typeof import('@/lib/crm/api/crm-client-provider')>()
  return { ...a, useCrmClient: () => mockClient }
})
vi.mock('@/components/notifications', async (i) => {
  const a = await i<typeof import('@/components/notifications')>()
  return { ...a, useNotifications: () => stableNotifications() }
})

const now = new Date().toISOString()
const CATS = [
  { id: '1', name: '家居', sortOrder: 0, createdAt: now },
  { id: '2', name: '3C', sortOrder: 1, createdAt: now },
]

beforeEach(() => {
  mockList.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockDelete.mockReset()
  mockList.mockResolvedValue(CATS)
})

describe('CrmCategoryManager（P6b 产品类目管理）', () => {
  it('渲染类目列表', async () => {
    const { container } = render(<CrmCategoryManager />)
    expect(await screen.findByText('家居')).toBeTruthy()
    expect(screen.getByText('3C')).toBeTruthy()
    expect(screen.getByRole('region', { name: '产品类目' })).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
  })

  it('新增类目调 createCategory 并刷新', async () => {
    mockCreate.mockResolvedValue({
      id: '3',
      name: '宠物用品',
      sortOrder: 2,
      createdAt: now,
    })
    render(<CrmCategoryManager />)
    await screen.findByText('家居')
    fireEvent.change(screen.getByTestId('new-category-name'), {
      target: { value: '宠物用品' },
    })
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ name: '宠物用品' })
    )
    await waitFor(() =>
      expect(mockList.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
  })

  it('行内改名调 updateCategory', async () => {
    render(<CrmCategoryManager />)
    await screen.findByText('家居')
    fireEvent.click(screen.getAllByRole('button', { name: '改名' })[0])
    const input = screen.getByDisplayValue('家居')
    fireEvent.change(input, { target: { value: '家具家居' } })
    fireEvent.click(screen.getByRole('button', { name: '确认改名' }))
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('1', { name: '家具家居' })
    )
  })

  it('删除需二次确认', async () => {
    render(<CrmCategoryManager />)
    await screen.findByText('家居')
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(screen.getByText(/删除将解除客户挂接/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除 家居' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('1'))
  })
})
