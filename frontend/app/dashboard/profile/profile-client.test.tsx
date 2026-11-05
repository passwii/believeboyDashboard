import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

interface ProjectFixture {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  is_active: boolean
  project_tier: string | null
}

const state = vi.hoisted(() => ({
  params: '',
  replace: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  notify: vi.fn(),
  projects: [] as ProjectFixture[],
  avatarPreview: null as null | { objectUrl: string; fromCache: boolean },
}))

const profile = vi.hoisted(() => ({
  id: 'user-1',
  email: 'damon@example.com',
  name: 'damon',
  full_name: '纪亚伟',
  is_admin: false,
  is_active: true,
  role_type: 'operator' as const,
  avatar_url: null,
  password_changed_at: new Date(0).toISOString(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: state.replace, push: state.replace }),
  useSearchParams: () => new URLSearchParams(state.params),
}))

vi.mock('next-auth/react', () => ({
  useSession: () =>
    stableSession({
      user: {
        id: 'user-1',
        email: 'damon@example.com',
        name: '纪亚伟',
        roleType: 'operator',
      },
    }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: state.notify }),
}))

vi.mock('@/lib/hooks/use-profile', () => ({
  useProfile: () => ({
    profile,
    loading: false,
    error: null,
    refetch: vi.fn(),
    update: state.updateProfile,
  }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(() => Promise.resolve(state.projects)),
}))

vi.mock('@/lib/user-avatar-cache', () => ({
  loadUserAvatar: vi.fn(() => Promise.resolve(state.avatarPreview)),
  invalidateUserAvatar: vi.fn(),
}))

vi.mock('@/lib/client-api/profile-client', () => ({
  deleteAvatar: vi.fn(),
  uploadAvatar: state.uploadAvatar,
}))

import ProfileClient from './profile-client'

beforeEach(() => {
  state.params = ''
  state.projects = []
  state.avatarPreview = null
  profile.avatar_url = null
  state.updateProfile.mockResolvedValue({
    ...profile,
    name: 'new-handle',
    full_name: '新姓名',
  })
  state.uploadAvatar.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Profile V4 Warm Ledger contract', () => {
  it('资料 tab 保留 useProfile 更新契约，并提交真实 PATCH 字段', async () => {
    const user = userEvent.setup()
    const { container } = render(<ProfileClient />)

    expect(await screen.findByRole('heading', { name: '我的资料' })).toBeInTheDocument()
    expect(container.querySelector('[data-warm-page="profile"]')).not.toBeNull()
    expect(screen.getByRole('tab', { name: '资料设置' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const nameInput = screen.getByLabelText('登录名 *')
    const fullNameInput = screen.getByLabelText('姓名')
    await user.clear(nameInput)
    await user.type(nameInput, 'new-handle')
    await user.clear(fullNameInput)
    await user.type(fullNameInput, '新姓名')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() =>
      expect(state.updateProfile).toHaveBeenCalledWith({
        name: 'new-handle',
        full_name: '新姓名',
      })
    )
  })

  it('URL tab 深链与 tab 切换写回保持', async () => {
    state.params = 'tab=avatar'
    render(<ProfileClient />)

    expect(screen.getByRole('tab', { name: '头像' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await userEvent.click(screen.getByRole('tab', { name: '我的项目' }))
    expect(state.replace).toHaveBeenCalledWith('/dashboard/profile?tab=projects', {
      scroll: false,
    })
  })

  it('tablist 使用 roving tabIndex，并支持方向键 / Home / End', async () => {
    const user = userEvent.setup()
    render(<ProfileClient />)

    const infoTab = screen.getByRole('tab', { name: '资料设置' })
    const avatarTab = screen.getByRole('tab', { name: '头像' })
    const projectsTab = screen.getByRole('tab', { name: '我的项目' })

    expect(infoTab).toHaveAttribute('tabindex', '0')
    expect(avatarTab).toHaveAttribute('tabindex', '-1')
    infoTab.focus()

    await user.keyboard('{ArrowRight}')
    expect(avatarTab).toHaveAttribute('aria-selected', 'true')
    expect(avatarTab).toHaveAttribute('tabindex', '0')
    expect(document.activeElement).toBe(avatarTab)

    await user.keyboard('{End}')
    expect(projectsTab).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(projectsTab)

    await user.keyboard('{Home}')
    expect(infoTab).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(infoTab)
    expect(state.replace).toHaveBeenCalledWith('/dashboard/profile?tab=avatar', {
      scroll: false,
    })
  })

  it('头像 tab 保留文件上传契约', async () => {
    const user = userEvent.setup()
    state.params = 'tab=avatar'
    const { container } = render(<ProfileClient />)

    const input = container.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    await user.upload(input as HTMLInputElement, file)

    await waitFor(() => expect(state.uploadAvatar).toHaveBeenCalledWith(file))
  })

  it('项目 tab 渲染真实项目行与项目信息链接', async () => {
    state.params = 'tab=projects'
    state.projects = [
      {
        id: 42,
        name: '店铺甲',
        brand_name: '品牌甲',
        store_address: 'https://example.com/store',
        project_operator: '纪亚伟',
        assistant_operator: null,
        commission_basis: 'sales_amount',
        commission_rate: 0.05,
        is_active: true,
        project_tier: 'T1',
      },
    ]

    render(<ProfileClient />)

    expect(await screen.findByText('店铺甲')).toBeInTheDocument()
    expect(screen.getByText('品牌甲')).toBeInTheDocument()
    expect(screen.getByText('5.00% · 销售额')).toBeInTheDocument()
    expect(screen.getByText('主运营')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看' })).toHaveAttribute(
      'href',
      '/dashboard/system/project-info?projectId=42'
    )
  })

  it('头像预览与删除确认使用 Radix 焦点陷阱，并在关闭后恢复触发按钮', async () => {
    const user = userEvent.setup()
    state.params = 'tab=avatar'
    profile.avatar_url = 'https://example.com/avatar.png'
    state.avatarPreview = { objectUrl: 'blob:avatar-preview', fromCache: true }

    render(<ProfileClient />)

    const previewTrigger = await screen.findByRole('button', {
      name: '查看 damon 头像原图',
    })
    await user.click(previewTrigger)
    const previewDialog = screen.getByRole('dialog', { name: '头像预览 — damon' })
    expect(previewDialog.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(previewTrigger)

    const deleteTrigger = screen.getByRole('button', { name: '删除头像' })
    await user.click(deleteTrigger)
    const deleteDialog = screen.getByRole('alertdialog', { name: '确认删除头像？' })
    expect(deleteDialog.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(deleteTrigger)
  })
})
