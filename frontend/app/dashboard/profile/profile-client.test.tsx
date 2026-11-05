import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

const state = vi.hoisted(() => ({
  params: '',
  replace: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  notify: vi.fn(),
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
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/user-avatar-cache', () => ({
  loadUserAvatar: vi.fn().mockResolvedValue(null),
  invalidateUserAvatar: vi.fn(),
}))

vi.mock('@/lib/client-api/profile-client', () => ({
  deleteAvatar: vi.fn(),
  uploadAvatar: state.uploadAvatar,
}))

import ProfileClient from './profile-client'

beforeEach(() => {
  state.params = ''
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
})
