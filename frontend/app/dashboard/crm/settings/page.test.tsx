import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationWrapper } from '@/components/system/notification-wrapper'
import type { WorkflowSettings } from '@/lib/crm/types'
import SettingsPage from './page'

const { getWorkflowSettings, updateWorkflowSettings, listRules, notify, sessionRef } = vi.hoisted(() => {
  const getWorkflowSettings = vi.fn(async (): Promise<WorkflowSettings> => ({
    staleDays: 7,
    staleEmailEnabled: true,
  }))
  const updateWorkflowSettings = vi.fn(
    async (input: Partial<WorkflowSettings>): Promise<WorkflowSettings> => ({
      staleDays: input.staleDays ?? 7,
      staleEmailEnabled: input.staleEmailEnabled ?? true,
    })
  )
  const listRules = vi.fn(async () => [])
  const notify = vi.fn()
  const sessionRef: { roleType: 'admin' | 'operator' | null } = { roleType: 'admin' }
  return { getWorkflowSettings, updateWorkflowSettings, listRules, notify, sessionRef }
})

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roleType: sessionRef.roleType } } }),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => {
  // 返回稳定对象引用（CrmRulesPanel 的 load useCallback 依赖 client 身份，新对象会无限重拉）
  const client = { getWorkflowSettings, updateWorkflowSettings, listRules }
  return { useCrmClient: () => client }
})

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
  // NotificationWrapper 需要 Provider；测试里用透传组件（toast 容器由 jsdom 无法动态加载，跳过）
  NotificationsProvider: ({ children }: { children: React.ReactNode }) => children,
  NotificationToastContainer: () => null,
}))

function renderPage() {
  return render(
    <NotificationWrapper>
      <SettingsPage />
    </NotificationWrapper>
  )
}

describe('SettingsPage（BLF-540 工作流设置）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionRef.roleType = 'admin'
    ;(getWorkflowSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      staleDays: 7,
      staleEmailEnabled: true,
    })
  })

  afterEach(() => {
    sessionRef.roleType = 'admin'
  })

  it('非管理员看到仅管理员提示，不加载设置', async () => {
    sessionRef.roleType = 'operator'
    renderPage()
    expect(await screen.findByText('仅管理员可查看与修改设置')).toBeInTheDocument()
    expect(getWorkflowSettings).not.toHaveBeenCalled()
  })

  it('管理员加载设置并展示开关与天数', async () => {
    renderPage()
    expect(await screen.findByText('7 天无跟进提醒')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '提醒邮件开关' })).toBeChecked()
    expect(screen.getByLabelText('无跟进天数')).toHaveValue(7)
  })

  it('保存调用 updateWorkflowSettings 并提示成功', async () => {
    renderPage()
    await screen.findByText('7 天无跟进提醒')

    fireEvent.click(screen.getByRole('switch', { name: '提醒邮件开关' }))
    const daysInput = screen.getByLabelText('无跟进天数')
    fireEvent.change(daysInput, { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updateWorkflowSettings).toHaveBeenCalledWith({
        staleDays: 14,
        staleEmailEnabled: false,
      })
    })
    expect(notify).toHaveBeenCalledWith({ type: 'success', title: '设置已保存' })
  })

  it('天数越界时保存按钮禁用并提示', async () => {
    renderPage()
    await screen.findByText('7 天无跟进提醒')
    const daysInput = screen.getByLabelText('无跟进天数')
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect(saveBtn).toBeEnabled()
    fireEvent.change(daysInput, { target: { value: '0' } })
    expect(saveBtn).toBeDisabled()
    fireEvent.change(daysInput, { target: { value: '400' } })
    expect(saveBtn).toBeDisabled()
    expect(updateWorkflowSettings).not.toHaveBeenCalled()
  })
})
