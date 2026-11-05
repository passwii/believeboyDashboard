import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  notify: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: state.notify }),
}))

import ChangePasswordPage from './page'

beforeEach(() => {
  state.fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ message: 'ok' }),
  })
  vi.stubGlobal('fetch', state.fetchMock)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('ChangePassword V4 Warm Ledger contract', () => {
  it('保留密码校验与 PATCH contract', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChangePasswordPage />)
    expect(container.querySelector('[data-warm-page="change-password"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: '修改密码' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('当前密码'), 'old-password')
    await user.type(screen.getByLabelText('新密码'), 'new-password')
    await user.type(screen.getByLabelText('确认新密码'), 'different-password')
    await user.click(screen.getByRole('button', { name: '确认修改' }))
    expect(state.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '两次输入的新密码不一致' })
    )
    expect(state.fetchMock).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('确认新密码'))
    await user.type(screen.getByLabelText('确认新密码'), 'new-password')
    await user.click(screen.getByRole('button', { name: '确认修改' }))

    await waitFor(() => expect(state.fetchMock).toHaveBeenCalledTimes(1))
    expect(state.fetchMock).toHaveBeenCalledWith('/api/user/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'old-password',
        newPassword: 'new-password',
      }),
    })
    expect(state.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    )
  })
})
