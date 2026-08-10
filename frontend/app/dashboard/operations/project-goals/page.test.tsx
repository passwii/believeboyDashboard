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

  it('BLF-595：进度概览点「去设置」直接切 tab 时立即拉取 goals 列表', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/project-goals/progress')) {
        // 有月度目标 → 显示「去设置」入口
        return jsonResponse({
          ...PROGRESS_PAYLOAD,
          monthly_progress: [
            {
              year: 2026,
              month: 8,
              month_label: '2026年8月',
              target_amount: 0,
              achieved_amount: 1000,
              completion_rate: 0,
              days_in_month: 31,
              today_day: 15,
              daily_target: 0,
              cumulative_daily_target: 0,
              completion_vs_daily: 0,
              completion_vs_monthly: 0,
              currency: 'USD',
            },
          ],
        })
      }
      if (url.includes('/project-goals?')) return jsonResponse(GOALS_PAYLOAD)
      return jsonResponse({})
    })
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })

    await user.click(await screen.findByRole('button', { name: /去设置/ }))
    // 去设置切 tab 时必须触发 goals 拉取（BLF-595 回归：不能只 setActiveTab）
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
    })
  })

  it('BLF-595：保存目标后立即 force 重载 progress 与 goals，目标表马上出现已设目标', async () => {
    const user = userEvent.setup()
    const progressCalls: string[] = []
    const goalsCalls: string[] = []
    let saved = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/project-goals/progress')) {
        progressCalls.push(url)
        return jsonResponse({
          ...PROGRESS_PAYLOAD,
          monthly_progress: [
            {
              year: 2026,
              month: 8,
              month_label: '2026年8月',
              target_amount: saved ? 10000 : 0,
              achieved_amount: 1000,
              completion_rate: 0,
              days_in_month: 31,
              today_day: 15,
              daily_target: saved ? 322.58 : 0,
              cumulative_daily_target: saved ? 4838.7 : 0,
              completion_vs_daily: 0,
              completion_vs_monthly: 0,
              currency: 'USD',
            },
          ],
        })
      }
      if (url.includes('/project-goals') && init?.method === 'POST') {
        saved = true
        return jsonResponse({ id: 1 })
      }
      if (url.includes('/project-goals?')) {
        goalsCalls.push(url)
        const goals = saved
          ? [
              {
                id: 1,
                project_id: 1,
                country: 'US',
                goal_type: 'monthly',
                metric_type: 'sales_amount',
                period_year: 2026,
                period_month: 8,
                target_amount: 10000,
                currency: 'USD',
                created_at: '',
                updated_at: '',
              },
            ]
          : []
        return jsonResponse({ goals, total: goals.length })
      }
      return jsonResponse({})
    })
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(progressCalls.length).toBeGreaterThanOrEqual(1)
    })

    // 经「去设置」进入目标管理 tab
    await user.click(await screen.findByRole('button', { name: /去设置/ }))
    await waitFor(() => {
      expect(goalsCalls.length).toBeGreaterThanOrEqual(1)
    })

    // 新增月度目标并保存
    await user.click(screen.getByRole('button', { name: /新增月度目标/ }))
    const amountInput = screen.getByPlaceholderText('例如：50000')
    await user.clear(amountInput)
    await user.type(amountInput, '10000')
    await user.click(screen.getByRole('button', { name: /保存/ }))

    // 保存后 goals 被 force 重载，目标表立即出现已设目标（无需手动刷新）
    await waitFor(() => {
      expect(goalsCalls.length).toBeGreaterThanOrEqual(2)
    })
    await waitFor(() => {
      expect(screen.getAllByText('$ 10,000.00').length).toBeGreaterThanOrEqual(1)
    })
  })
})
