import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CrmOverviewDrawer } from './index'
import { NotificationsProvider } from '@/components/notifications'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { Customer } from '@/lib/crm/types'

// 稳定引用：useCrmClient 每次渲染返回新对象会让依赖 client 的 effect 反复重跑
const { client } = vi.hoisted(() => ({
  client: {
    updateValueScores: vi.fn(),
    listCategories: vi.fn().mockResolvedValue([]),
    setCustomerCategories: vi.fn(),
    listProposals: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 }),
  },
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))

vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'u1' }),
}))

const customer: Customer = {
  id: 'c1',
  name: '测试客户',
  rating: 'A',
  categories: [],
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

  it('客户抽屉有「方案」tab，点开后展示关联方案（空态引导）', async () => {
    renderDrawer()
    const proposalsTab = screen.getByRole('tab', { name: '方案' })
    fireEvent.mouseDown(proposalsTab)
    fireEvent.click(proposalsTab)
    expect(await screen.findByText(/该客户还没有关联方案/)).toBeTruthy()
  })

  it('非客户实体（线索）不渲染「方案」tab', () => {
    render(
      <NotificationsProvider>
        <CrmOverviewDrawer<Record<string, unknown>>
          open
          onOpenChange={vi.fn()}
          entityType="lead"
          entityId="l1"
          data={{}}
          fields={[]}
          title="线索甲"
          users={[]}
          loadFollows={vi.fn().mockResolvedValue([])}
          createFollow={vi.fn().mockResolvedValue({})}
          onSave={vi.fn()}
        />
      </NotificationsProvider>
    )
    expect(screen.queryByRole('tab', { name: '方案' })).toBeNull()
    expect(screen.getByRole('tab', { name: '详情' })).toBeTruthy()
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
