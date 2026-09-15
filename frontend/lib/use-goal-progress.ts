'use client'

import { useEffect, useRef, useState } from 'react'
import type { Session } from 'next-auth'

import { isGoalProgressScopeValid } from '@/components/ui/goal-progress-rings'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

const API_BASE = '/api/backend'

export type GoalProgress = {
  month: number
  target_amount: number
  achieved_amount: number
  completion_vs_monthly: number
  completion_vs_daily: number
  today_day: number
  days_in_month: number
  currency: string
}

type GoalProgressResponse = {
  monthly_progress?: GoalProgress[]
}

/**
 * Load the current month's goal for a concrete project/site scope.
 *
 * A scope change clears the previous value immediately. Cleanup plus a request
 * sequence guard prevents stale responses from painting project A's progress
 * after the page has already moved to project B.
 */
export function useGoalProgress(
  projectId: string,
  country: string,
  session: Session | null | undefined
): { goalProgress: GoalProgress | null; goalLoading: boolean } {
  const [goalProgress, setGoalProgress] = useState<GoalProgress | null>(null)
  const [goalLoading, setGoalLoading] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current
    let cancelled = false

    if (!isGoalProgressScopeValid(projectId, country)) {
      setGoalProgress(null)
      setGoalLoading(false)
      return () => {
        cancelled = true
      }
    }

    const year = new Date().getFullYear()
    const month = new Date().getMonth() + 1
    setGoalProgress(null)
    setGoalLoading(true)

    fetchOpsJsonCached<GoalProgressResponse>(
      `${API_BASE}/api/v1/project-goals/progress?project_id=${projectId}&country=${country}&year=${year}`,
      { session }
    )
      .then((data) => {
        if (cancelled || requestId !== requestRef.current) return
        setGoalProgress(
          (data.monthly_progress ?? []).find((item) => item.month === month) ?? null
        )
      })
      .catch(() => {
        if (cancelled || requestId !== requestRef.current) return
        setGoalProgress(null)
      })
      .finally(() => {
        if (cancelled || requestId !== requestRef.current) return
        setGoalLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, country, session])

  return { goalProgress, goalLoading }
}
