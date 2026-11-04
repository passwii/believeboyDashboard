import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stableNotifications } from '@/test-utils/stable-mocks'
import type { AlertPreference } from '@/lib/alerts-api'

const { fetchPreferencesMock, updatePreferencesMock } = vi.hoisted(() => ({
  fetchPreferencesMock: vi.fn(),
  updatePreferencesMock: vi.fn(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/alerts-api', () => ({
  fetchAlertPreferences: fetchPreferencesMock,
  updateAlertPreferences: updatePreferencesMock,
}))

import { notify } from '@/test-utils/stable-mocks'
import { AlertPreferencesTab } from './alert-preferences-tab'

const SAVED_PREFERENCES: AlertPreference = {
  email_enabled: true,
  in_app_enabled: true,
  min_severity: 'warning',
  quiet_hours_start: '22:00',
  quiet_hours_end: '08:00',
}

const REMOTE_PREFERENCES: AlertPreference = {
  ...SAVED_PREFERENCES,
  email_enabled: false,
  min_severity: 'critical',
}

describe('AlertPreferencesTab Head refresh', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('refreshes server preferences without overwriting a dirty unsaved draft', async () => {
    fetchPreferencesMock
      .mockResolvedValueOnce(SAVED_PREFERENCES)
      .mockResolvedValueOnce(REMOTE_PREFERENCES)
    let refresh = async () => {}
    const user = userEvent.setup()
    const { container } = render(
      <AlertPreferencesTab onRefreshReady={(handler) => { refresh = handler }} />
    )

    const emailSwitch = (await screen.findAllByRole('switch'))[0]!
    expect(
      container.querySelector('[data-warm-alert-preferences="true"]')
    ).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(emailSwitch).toBeChecked()
    await user.click(emailSwitch)
    expect(emailSwitch).not.toBeChecked()

    await act(async () => { await refresh() })

    expect(fetchPreferencesMock).toHaveBeenCalledTimes(2)
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).not.toBeChecked()
    expect(switches[1]).toBeChecked()
    expect(notify).not.toHaveBeenCalled()
  })

  it('保存偏好时提交当前草稿', async () => {
    fetchPreferencesMock.mockResolvedValueOnce(SAVED_PREFERENCES)
    updatePreferencesMock.mockResolvedValueOnce({
      ...SAVED_PREFERENCES,
      email_enabled: false,
    })
    const user = userEvent.setup()
    render(<AlertPreferencesTab />)

    const emailSwitch = (await screen.findAllByRole('switch'))[0]!
    await user.click(emailSwitch)
    await user.click(screen.getByRole('button', { name: '保存偏好' }))

    await waitFor(() =>
      expect(updatePreferencesMock).toHaveBeenCalledWith({
        ...SAVED_PREFERENCES,
        email_enabled: false,
      })
    )
    expect(notify).toHaveBeenCalledWith({ type: 'success', title: '偏好已保存' })
  })
})
