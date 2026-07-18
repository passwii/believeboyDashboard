import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CrmOverviewDrawer } from './index'
import { NotificationsProvider } from '@/components/notifications'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { Customer } from '@/lib/crm/types'

const customer: Customer = {
  id: 'c1',
  name: '测试客户',
  rating: 'A',
  status: 'active',
  source: 'referral',
  ownerId: 'u1',
  ownerName: '小王',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: 'u1',
}

function renderDrawer(extra?: { actions?: React.ReactNode }) {
  return render(
    <NotificationsProvider>
      <CrmOverviewDrawer<Customer>
        open
        onOpenChange={vi.fn()}
        entityType="customer"
        entityId="c1"
        data={customer}
        fields={CUSTOMER_FIELD_DEFS}
        title={customer.name}
        users={[]}
        loadFollows={vi.fn().mockResolvedValue([])}
        createFollow={vi.fn().mockResolvedValue({})}
        onSave={vi.fn()}
        {...extra}
      />
    </NotificationsProvider>
  )
}

describe('CrmOverviewDrawer', () => {
  it('详情 tab 渲染字段', () => {
    renderDrawer()
    // "测试客户" 同时出现在标题与 name 字段值
    expect(screen.getAllByText('测试客户').length).toBeGreaterThanOrEqual(2)
  })

  it('actions 槽渲染自定义按钮（线索转客户/公海领取）', () => {
    renderDrawer({ actions: <button type="button">转为客户</button> })
    expect(screen.getByText('转为客户')).toBeTruthy()
  })

  it('编辑 tab 进入编辑模式', async () => {
    renderDrawer()
    // Radix Tabs 非激活 content 默认卸载，需先切到"编辑"tab
    const editTab = screen.getByRole('tab', { name: '编辑' })
    fireEvent.mouseDown(editTab)
    fireEvent.click(editTab)
    const editBtn = await screen.findByRole('button', { name: '编辑信息' })
    expect(editBtn).toBeTruthy()
    fireEvent.click(editBtn)
    // 进入编辑 → 懒加载表单（Suspense）
    expect(await screen.findByText('保存修改')).toBeTruthy()
  })
})
