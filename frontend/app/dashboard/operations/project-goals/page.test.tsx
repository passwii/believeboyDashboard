import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// BEL-423：目标管理页按 tab 取数 —— mount 只拉 progress，goals 列表首次进入
// "目标管理" tab 才拉；且 2min 客户端缓存内重复切 tab 不重复请求。

// 稳定引用：mock 的 useSession / useNotifications 若每次 render 返回新对象，
// 会让把它们放进 deps 的 effect 无限循环（真实实现里 context 值稳定）。
const { SESSION_DATA, NOTIFY } = vi.hoisted(() => ({
  SESSION_DATA: { user: { id: 'u1', roleType: 'admin', operatorNameZh: '测试' } },
  NOTIFY: { notify: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION_DATA, status: 'authenticated' }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '项目A' }]),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

import { clearOpsClientCaches } from '@/lib/ops-client-cache'
import ProjectGoalsPage from './page'

const PROGRESS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  currency: 'USD',
  year: 2026,
  monthly_progress: [],
  annual_progress: null,
}

const GOALS_PAYLOAD = { goals: [], total: 0 }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ProjectGoalsPage 按 tab 懒加载（BEL-423）', () => {
  beforeEach(() => {
    clearOpsClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  function mountWithFetch() {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/project-goals/progress')) return jsonResponse(PROGRESS_PAYLOAD)
      if (url.includes('/project-goals?')) return jsonResponse(GOALS_PAYLOAD)
      return jsonResponse({})
    })
    return calls
  }

  it('mount 只请求 progress，不请求 goals 列表', async () => {
    const calls = mountWithFetch()
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })
    expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(0)
  })

  it('首次进入"目标管理" tab 才请求 goals 列表；来回切 tab 不重复请求', async () => {
    const user = userEvent.setup()
    const calls = mountWithFetch()
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })

    await user.click(screen.getByRole('tab', { name: '目标管理' }))
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
    })

    await user.click(screen.getByRole('tab', { name: '进度概览' }))
    await user.click(screen.getByRole('tab', { name: '目标管理' }))
    expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
  })
})
