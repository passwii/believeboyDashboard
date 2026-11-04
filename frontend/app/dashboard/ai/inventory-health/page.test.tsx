import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', name: '张三' } }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 12, name: '库存项目', brand_name: 'Inventory Brand' },
  ]),
}))

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

import InventoryHealthPage from './page'

describe('InventoryHealthPage Warm migration', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/backend/v1/insight/inventory-health/runs')) {
        return jsonResponse({ run_id: 'inventory-run-page', status: 'queued', attempt: 1 })
      }
      return jsonResponse({ error: 'test terminal' }, 500)
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('保留单日快照 canonical run 并挂载 Warm 页面', async () => {
    const user = userEvent.setup()
    const { container } = render(<InventoryHealthPage />)

    expect(container.querySelector('[data-warm-inventory-health]')).toBeInTheDocument()

    const generateButton = await screen.findByRole('button', { name: '立即生成' })
    expect(generateButton).toHaveClass('warm-ledger__button')
    await user.click(generateButton)

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((entry) =>
        String(entry[0]).includes('/api/backend/v1/insight/inventory-health/runs')
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        project_id: 12,
        country: 'US',
      })
    })
    expect(document.querySelector('[data-insight-appearance="warm"]')).toBeInTheDocument()
  })
})
