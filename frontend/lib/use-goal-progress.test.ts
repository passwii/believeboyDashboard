import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useGoalProgress } from './use-goal-progress'

vi.mock('@/lib/ops-client-cache', () => ({
  fetchOpsJsonCached: vi.fn(),
}))

const fetchGoal = vi.mocked(fetchOpsJsonCached)

const currentMonth = new Date().getMonth() + 1

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('useGoalProgress', () => {
  beforeEach(() => {
    fetchGoal.mockReset()
  })

  it('切换项目时立即清空旧进度，并忽略过期响应', async () => {
    const projectA = deferred<unknown>()
    const projectB = deferred<unknown>()
    const projectC = deferred<unknown>()
    fetchGoal
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise)
      .mockReturnValueOnce(projectC.promise)

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useGoalProgress(projectId, 'US', null),
      { initialProps: { projectId: 'A' } }
    )

    await act(async () => {
      projectA.resolve({ monthly_progress: [progress(currentMonth, 0.2)] })
    })
    await waitFor(() => expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.2))

    rerender({ projectId: 'B' })
    expect(result.current.goalProgress).toBeNull()
    expect(result.current.goalLoading).toBe(true)

    rerender({ projectId: 'C' })
    await act(async () => {
      projectB.resolve({ monthly_progress: [progress(currentMonth, 0.9)] })
    })
    expect(result.current.goalProgress).toBeNull()
    expect(result.current.goalLoading).toBe(true)

    await act(async () => {
      projectC.resolve({ monthly_progress: [progress(currentMonth, 0.7)] })
    })
    expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.7)
    expect(result.current.goalLoading).toBe(false)
  })

  it('无当前月份目标时明确清空已有进度', async () => {
    fetchGoal
      .mockResolvedValueOnce({ monthly_progress: [progress(currentMonth, 0.4)] })
      .mockResolvedValueOnce({ monthly_progress: [progress(currentMonth === 1 ? 2 : 1)] })
    const { result, rerender } = renderHook(
      ({ country }: { country: string }) => useGoalProgress('7', country, null),
      { initialProps: { country: 'DE' } }
    )

    await waitFor(() => expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.4))
    // 改变国家以触发同一页面上的新目标请求。
    rerender({ country: 'UK' })
    expect(result.current.goalProgress).toBeNull()

    await waitFor(() => expect(result.current.goalLoading).toBe(false))
    expect(result.current.goalProgress).toBeNull()
  })

  it('请求失败时明确清空已有进度并结束加载状态', async () => {
    fetchGoal
      .mockResolvedValueOnce({ monthly_progress: [progress(currentMonth, 0.4)] })
      .mockRejectedValueOnce(new Error('network'))
    const { result, rerender } = renderHook(
      ({ country }: { country: string }) => useGoalProgress('7', country, null),
      { initialProps: { country: 'UK' } }
    )

    await waitFor(() => expect(result.current.goalProgress?.completion_vs_monthly).toBe(0.4))
    rerender({ country: 'DE' })
    expect(result.current.goalProgress).toBeNull()

    await waitFor(() => expect(result.current.goalLoading).toBe(false))
    expect(result.current.goalProgress).toBeNull()
  })

  it('按站点时区计算当前年月', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'))
    fetchGoal.mockResolvedValue({
      monthly_progress: [progress(12, 0.4), progress(1, 0.8)],
    })

    try {
      const { result } = renderHook(() => useGoalProgress('7', 'US', null))

      await act(async () => {
        await Promise.resolve()
      })

      expect(fetchGoal).toHaveBeenCalledWith(
        expect.stringContaining('year=2025'),
        expect.objectContaining({ session: null })
      )
      expect(result.current.goalProgress?.month).toBe(12)
    } finally {
      vi.useRealTimers()
    }
  })
})
