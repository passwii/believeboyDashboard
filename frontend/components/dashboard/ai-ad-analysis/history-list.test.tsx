import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const INSIGHT = {
  id: 41,
  project_id: 7,
  project_name: '广告项目',
  country: 'US',
  title: '广告周报',
  insight_type: 'ad_analysis',
  date_range_start: '2026-09-01',
  date_range_end: '2026-09-07',
  status: 'completed',
  sub_status: null,
  created_by: '张三',
  created_at: '2026-09-08T08:00:00Z',
  updated_at: '2026-09-08T08:00:00Z',
}

import { HistoryList } from './history-list'

describe('HistoryList Warm migration', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        return jsonResponse({ ...INSIGHT, content: '# 已更新的广告正文' })
      }
      if (init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      if (url.includes('/api/backend/v1/ai-insights?')) {
        return jsonResponse({ items: [INSIGHT], total: 1 })
      }
      if (url.includes('/api/backend/v1/ai-insights/41')) {
        return jsonResponse({ ...INSIGHT, content: '# 广告正文' })
      }
      return jsonResponse({ error: 'test terminal' }, 500)
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('保留查看、编辑与删除写路径，并挂载 Warm 历史边界', async () => {
    const user = userEvent.setup()
    const { container } = render(<HistoryList projectId={7} country="US" />)

    expect(container.querySelector('[data-warm-ad-history]')).toBeInTheDocument()
    expect(await screen.findByText('广告周报')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '查看' }))
    expect(await screen.findByRole('heading', { name: '广告正文' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '编辑' }))
    const textarea = screen.getByRole('textbox')
    await user.clear(textarea)
    await user.type(textarea, '# 已更新的广告正文')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const putCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (entry) => entry[1]?.method === 'PUT'
      )
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        content: '# 已更新的广告正文',
      })
    })

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))

    await waitFor(() => {
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          (entry) => entry[1]?.method === 'DELETE'
        )
      ).toBe(true)
    })
  })
})
