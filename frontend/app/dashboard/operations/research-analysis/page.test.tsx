import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { SESSION, NOTIFY } = vi.hoisted(() => ({
  SESSION: { user: { id: 'u1', roleType: 'admin', isAdmin: true, full_name: '测试' } },
  NOTIFY: { notify: vi.fn() },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION, status: 'authenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import ResearchAnalysisPage from './page'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ResearchAnalysisPage Warm Ledger 契约', () => {
  it('使用 Warm Ledger 页面壳且不混用 Terminal 表面', () => {
    const { container } = render(<ResearchAnalysisPage />)

    const page = screen.getByTestId('research-analysis-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })
})
