import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmRulesPanel } from './crm-rules-panel'
import { NotificationWrapper } from '@/components/system/notification-wrapper'
import type { Rule } from '@/lib/crm/types'


const seedRules: Rule[] = [
  {
    id: 1,
    name: '客户 7 天无跟进提醒',
    description: '客户创建超过 7 天且从未跟进 → 提醒负责人',
    entityType: 'customer',
    eventType: 'stale_follow_up',
    enabled: true,
    priority: 0,
    conditions: [
      { field: 'days_since_created', operator: 'gte', value: '7', sortOrder: 0 },
      { field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 },
    ],
    actions: [{ actionType: 'notify_owner', params: null, sortOrder: 0 }],
    createdAt: '2026-08-08T00:00:00+00:00',
    updatedAt: '2026-08-08T00:00:00+00:00',
  },
]

const { listRules, createRule, updateRule, deleteRule } = vi.hoisted(() => ({
  listRules: vi.fn(async () => seedRules),
  createRule: vi.fn(async (input: unknown) => ({
    id: 99,
    ...(input as object),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  updateRule: vi.fn(async (id: number, input: unknown) => ({
    ...seedRules[0]!,
    id,
    ...(input as object),
    updatedAt: new Date().toISOString(),
  })),
  deleteRule: vi.fn(async () => undefined),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => {
  // 返回稳定对象引用（否则每次 render 生成新 client → load 依赖变化 → 死循环拉取）
  const client = { listRules, createRule, updateRule, deleteRule }
  return { useCrmClient: () => client }
})

beforeEach(() => {
  vi.clearAllMocks()
})

function renderPanel() {
  return render(
    <NotificationWrapper>
      <CrmRulesPanel />
    </NotificationWrapper>
  )
}

describe('CrmRulesPanel（规则引擎设置面板，P9-7 BLF-545）', () => {
  it('加载并渲染规则列表 + 摘要句子 + 启停状态', async () => {
    const { container } = renderPanel()
    expect(await screen.findByText('客户 7 天无跟进提醒')).toBeTruthy()
    expect(screen.getByText('当客户创建超过 7 天 且 从未跟进 → 提醒负责人')).toBeTruthy()
    expect(screen.getByText('启用中')).toBeTruthy()
    expect(listRules).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: '规则引擎' })).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
  })

  it('listRules 抛错 → 展示无权限兜底（后端 require_admin 403）', async () => {
    listRules.mockRejectedValueOnce(new Error('403'))
    renderPanel()
    expect(await screen.findByText('无权限管理规则引擎（仅管理员）')).toBeTruthy()
  })

  it('新建规则：填写表单提交 → createRule 收到 MVP 结构输入', async () => {
    renderPanel()
    fireEvent.click(await screen.findByText('新建规则'))
    await screen.findByText(/可视化配置「当 X 发生，做 Y」。MVP 支持/)
    expect(screen.getByRole('dialog', { name: '新建规则' })).toHaveAttribute(
      'data-warm-rule-editor'
    )

    const nameInput = screen.getByPlaceholderText('如：客户 7 天无跟进提醒')
    fireEvent.change(nameInput, { target: { value: '客户 10 天无跟进提醒' } })
    fireEvent.change(screen.getByLabelText('创建超过天数'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(createRule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '客户 10 天无跟进提醒',
          entityType: 'customer',
          eventType: 'stale_follow_up',
          enabled: true,
          conditions: expect.arrayContaining([
            expect.objectContaining({ field: 'days_since_created', operator: 'gte', value: '10' }),
            expect.objectContaining({ field: 'last_follow_at', operator: 'is_null' }),
          ]),
          actions: [expect.objectContaining({ actionType: 'notify_owner' })],
        })
      )
    })
    expect(await screen.findByText('客户 10 天无跟进提醒')).toBeTruthy()
  })

  it('规则名称必填：空名提交被 zod 拦截', async () => {
    renderPanel()
    fireEvent.click(await screen.findByText('新建规则'))
    await screen.findByText(/可视化配置「当 X 发生，做 Y」。MVP 支持/)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请输入规则名称')).toBeTruthy()
    expect(createRule).not.toHaveBeenCalled()
  })

  it('编辑规则：预填表单 → 提交调用 updateRule(id, …)', async () => {
    renderPanel()
    await screen.findByText('客户 7 天无跟进提醒')
    fireEvent.click(screen.getByRole('button', { name: '编辑规则 客户 7 天无跟进提醒' }))
    const nameInput = screen.getByPlaceholderText('如：客户 7 天无跟进提醒') as HTMLInputElement
    expect(nameInput.value).toBe('客户 7 天无跟进提醒')
    fireEvent.change(nameInput, { target: { value: '客户 14 天无跟进提醒' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(updateRule).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: '客户 14 天无跟进提醒' })
      )
    })
  })

  it('启停开关：切换调用 updateRule(id, { enabled })', async () => {
    renderPanel()
    await screen.findByText('客户 7 天无跟进提醒')
    fireEvent.click(screen.getByRole('switch', { name: '停用规则 客户 7 天无跟进提醒' }))
    await waitFor(() => {
      expect(updateRule).toHaveBeenCalledWith(1, { enabled: false })
    })
    expect(await screen.findByText('已停用')).toBeTruthy()
  })

  it('删除规则：确认后调用 deleteRule 并从列表移除', async () => {
    renderPanel()
    await screen.findByText('客户 7 天无跟进提醒')
    fireEvent.click(screen.getByRole('button', { name: '删除规则 客户 7 天无跟进提醒' }))
    const confirmBtn = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(deleteRule).toHaveBeenCalledWith(1)
    })
    expect(screen.queryByText('客户 7 天无跟进提醒')).toBeNull()
  })

  it('删除确认取消：不调用 deleteRule', async () => {
    renderPanel()
    await screen.findByText('客户 7 天无跟进提醒')
    fireEvent.click(screen.getByRole('button', { name: '删除规则 客户 7 天无跟进提醒' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(deleteRule).not.toHaveBeenCalled()
  })
})
