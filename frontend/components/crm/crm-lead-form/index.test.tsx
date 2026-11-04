import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { User } from '@/lib/crm/types/user'
import { CrmLeadForm } from './index'

const users: User[] = [
  {
    id: 'u-1',
    name: '林夏',
    email: 'linxia@example.com',
    roleType: 'operator',
    isActive: true,
  },
  {
    id: 'u-2',
    name: '周岚',
    email: 'zhoulan@example.com',
    roleType: 'operator',
    isActive: true,
  },
]

describe('CrmLeadForm', () => {
  it('keeps required validation and submits the existing LeadInput contract', async () => {
    const onSubmit = vi.fn()
    const { container } = render(<CrmLeadForm users={users} onSubmit={onSubmit} submitText="创建线索" />)

    expect(container.querySelector('[data-warm-lead-form]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建线索' }))
    expect(await screen.findByText('联系人必填')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('联系人 *'), { target: { value: '刘晨' } })
    fireEvent.change(screen.getByLabelText('公司'), { target: { value: '远帆供应链' } })
    fireEvent.change(screen.getByLabelText('电话'), { target: { value: '13800000000' } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'liu@example.com' } })
    fireEvent.change(screen.getByLabelText('微信'), { target: { value: 'liu-chen' } })
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'exhibition' } })
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'contacting' } })
    fireEvent.change(screen.getByLabelText('意向'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('负责人'), { target: { value: 'u-2' } })
    fireEvent.change(screen.getByLabelText('预计金额'), { target: { value: '88000' } })
    fireEvent.change(screen.getByLabelText('预计成交日'), { target: { value: '2026-12-31' } })
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '展会后续沟通' } })
    fireEvent.click(screen.getByRole('button', { name: '创建线索' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: '刘晨',
        company: '远帆供应链',
        phone: '13800000000',
        email: 'liu@example.com',
        wechat: 'liu-chen',
        source: 'exhibition',
        status: 'contacting',
        intent: 'high',
        ownerId: 'u-2',
        expectedAmount: 88000,
        expectedCloseDate: '2026-12-31',
        remark: '展会后续沟通',
      })
    })
  })
})
