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

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(false) }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 7, name: '广告项目', brand_name: 'Brand' },
  ]),
}))

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

import AdAnalysisPage from './page'

describe('AdAnalysisPage Warm migration', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/backend/v1/insight/ad-analysis/runs')) {
        return jsonResponse({ run_id: 'ad-run-page', status: 'queued', attempt: 1 })
      }
      if (url.includes('/api/backend/v1/ai-insights?')) {
        return jsonResponse({ items: [], total: 0 })
      }
      if (url.includes('/api/backend/v1/ai-insights/schedules')) {
        return jsonResponse({ items: [] })
      }
      return jsonResponse({ error: 'test terminal' }, 500)
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('保留 canonical 广告 run 提交并挂载 Warm 页面', async () => {
    const user = userEvent.setup()
    const { container } = render(<AdAnalysisPage />)

    expect(container.querySelector('[data-warm-ad-analysis]')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '历史记录' })).toBeInTheDocument()

    const generateButton = await screen.findByRole('button', { name: '立即生成' })
    expect(generateButton).toHaveClass('warm-ledger__button')
    await user.click(generateButton)

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((entry) =>
        String(entry[0]).includes('/api/backend/v1/insight/ad-analysis/runs')
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        project_id: 7,
        country: 'US',
        start_date: expect.any(String),
        end_date: expect.any(String),
      })
    })
    expect(document.querySelector('[data-insight-appearance="warm"]')).toBeInTheDocument()
  })

  it('定时任务 Tab 仍按 ad_analysis 过滤原调度端点', async () => {
    const user = userEvent.setup()
    render(<AdAnalysisPage />)

    await user.click(screen.getByRole('tab', { name: '定时任务' }))

    expect(await screen.findByText('定时任务管理')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
          String(call[0]).includes(
            '/api/backend/v1/ai-insights/schedules?insight_type=ad_analysis'
          )
        )
      ).toBe(true)
    )
  })
})
