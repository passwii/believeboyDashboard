import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useGoalProgress } from './use-goal-progress'

vi.mock('@/lib/ops-client-cache', () => ({
  fetchOpsJsonCached: vi.fn(),
}))

const fetchGoal = vi.mocked(fetchOpsJsonCached)

const progress = (month: number, completion = 0.4) => ({
  month,
  target_amount: 1000,
  achieved_amount: 400,
  completion_vs_monthly: completion,
  completion_vs_daily: 0.8,
  today_day: 15,
  days_in_month: 30,
  currency: '$',
})

describe('useGoalProgress', () => {
  beforeEach(() => {
    fetchGoal.mockReset()
  })

  it('切换项目时立即清空旧进度，并忽略过期响应', async () => {
    let resolveA!: (value: unknown) => void
    let resolveB!: (value: unknown) => void
    fetchGoal
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve }))

    const { result, rerender } = renderHook(
      ({ projectId }) => useGoalProgress(projectId, 'US', null),
      { initialProps: { projectId: 'A' } }
    )

    await act(async () => {
      resolveA({ monthly_progress: [progress(new Date().getMonth() + 1, 0.2)] })
    })
    expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.2)

    rerender({ projectId: 'B' })
    expect(result.current.goalProgress).toBeNull()
    expect(result.current.goalLoading).toBe(true)

    await act(async () => {
      resolveA({ monthly_progress: [progress(new Date().getMonth() + 1, 0.9)] })
      resolveB({ monthly_progress: [progress(new Date().getMonth() + 1, 0.7)] })
    })
    expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.7)
  })

  it('无当前月份目标时明确置空', async () => {
    fetchGoal.mockResolvedValue({ monthly_progress: [progress(1)] })
    const { result } = renderHook(() => useGoalProgress('7', 'DE', null))

    await waitFor(() => expect(result.current.goalLoading).toBe(false))
    expect(result.current.goalProgress).toBeNull()
  })

  it('请求失败时明确置空并结束加载状态', async () => {
    fetchGoal.mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useGoalProgress('7', 'UK', null))

    await waitFor(() => expect(result.current.goalLoading).toBe(false))
    expect(result.current.goalProgress).toBeNull()
  })
})
