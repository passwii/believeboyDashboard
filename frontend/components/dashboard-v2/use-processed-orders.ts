'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * BLF-928：Dashboard 订单流面板的"已处理"订单集合。
 *
 * PATCH /api/v1/order-info/{id} 只更新 carrier/tracking_no/shipped_at/updated_by，
 * 不改变 order_status（仍为 Pending），因此标记处理后的订单再调用 overview 仍会返回。
 * 本 hook 维护一个持久化的"已处理"订单 id 集合，在组件侧过滤列表和计数，
 * 实现"操作后本地计数/列表即时更新"的闭环。
 *
 * 各项目/日期窗口的已处理集合独立存储，切换窗口展示新的待处理队列。
 */

const STORAGE_KEY = 'bb.dashboard.order-flow.processed'

function getWindowMap(): Record<string, number[]> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return {}
    const map: Record<string, number[]> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (Array.isArray(val)) {
        map[key] = val.filter((n): n is number => typeof n === 'number')
      }
    }
    return map
  } catch {
    return {}
  }
}

function writeWindowMap(map: Record<string, number[]>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* 写入失败静默降级 */
  }
}

export interface UseProcessedOrdersResult {
  processedIds: Set<number>
  /** 新增一批 id 到已处理集合 */
  markProcessed: (ids: number[]) => void
}

/**
 * @param windowKey（如 `${projectIdsKey}|${dateFrom}|${dateTo}`）—— 窗口变化时自动切换集合。
 */
export function useProcessedOrders(windowKey: string): UseProcessedOrdersResult {
  const [processedIds, setProcessedIds] = useState<Set<number>>(() => {
    return new Set(getWindowMap()[windowKey] ?? [])
  })

  // 窗口变化 → 重读该窗口的已处理 id
  useEffect(() => {
    setProcessedIds(new Set(getWindowMap()[windowKey] ?? []))
  }, [windowKey])

  const markProcessed = useCallback(
    (ids: number[]) => {
      setProcessedIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.add(id))
        const map = getWindowMap()
        map[windowKey] = [...next]
        writeWindowMap(map)
        return next
      })
    },
    [windowKey]
  )

  return { processedIds, markProcessed }
}