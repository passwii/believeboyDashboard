import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentUsageGuide } from './agent-usage-guide'

describe('AgentUsageGuide Warm Ledger', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('使用 Warm 本地表面，并保留后端地址自动填充', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ base_url: 'https://api.example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { container } = render(<AgentUsageGuide />)

    expect(
      container.querySelector('[data-warm-agent-usage-guide="true"]')
    ).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(screen.getByText('如何告诉 Agent 调用')).toBeTruthy()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/backend-base', { cache: 'no-store' })
    )
    expect(await screen.findByText('https://api.example.com')).toBeTruthy()
  })
})
