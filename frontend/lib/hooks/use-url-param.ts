'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * useUrlParam — 把单个值同步到 URL search param。
 *
 * 设计要点（URL 是单一真理之源，避免 state/URL 漂移）：
 *  1. value 直接从 URL 读取，不维护本地 useState → 刷新 / 分享链接 / 浏览器后退全部天然可用。
 *  2. 写入走 router.replace（不是 push），避免每次切换项目都在历史栈里堆一条记录。
 *  3. 设置成默认值时会从 URL 删除该 key，保持 URL 干净（不要出现 ?project= 这种空值）。
 *  4. allowed 选项用于"URL 里的值不在合法集合内就回退到默认值"的场景；
 *     比如 ?country=XX → 当成没传过，走默认值 'US'。
 *
 * 用法：
 *  // 单字段
 *  const [projectId, setProjectId] = useUrlParam('project', '')
 *
 *  // 单字段 + 合法值校验
 *  const [country, setCountry] = useUrlParam<CountryOption>('country', 'US', {
 *    allowed: ['US', 'DE', 'UK', 'ALL'] as const,
 *  })
 */
export function useUrlParam<T extends string>(
  key: string,
  defaultValue: T,
  options?: { allowed?: ReadonlyArray<T> },
): readonly [T, (next: T) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const raw = searchParams.get(key) ?? defaultValue
  const value: T =
    options?.allowed && !options.allowed.includes(raw as T)
      ? defaultValue
      : (raw as T)

  const setValue = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString())
      if (!next || next === defaultValue) {
        params.delete(key)
      } else {
        params.set(key, next)
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [searchParams, router, pathname, key, defaultValue],
  )

  return [value, setValue] as const
}

/**
 * useUrlParams — 一次同步多个字段到 URL search params。
 *
 * 适合"控制台一次性有 4-5 个筛选字段"的场景（项目 / 国家 / 起止日期 / 月份 等），
 * 比每字段单独 useUrlParam 调用更紧凑，且能保证多次 setter 在同一帧内合并成一次路由 replace。
 *
 * 用法：
 *  const [filters, setFilters] = useUrlParams({
 *    project: '',
 *    country: 'US',
 *    from: '2026-06-01',
 *    to: '2026-06-30',
 *  })
 *
 *  // 只更新 country，其它字段不动
 *  setFilters({ country: 'DE' })
 *
 *  // 一次更新多个
 *  setFilters({ country: 'DE', from: '2026-05-01', to: '2026-05-31' })
 *
 * 注意：setFilters 接受 Partial，因此传入的字段会被更新，未传入的字段保持 URL 当前值不变。
 *       设回默认值（首次调用时的 default）的字段会从 URL 删除，保持 URL 干净。
 */
export function useUrlParams<T extends Record<string, string>>(
  defaults: T,
): readonly [T, (updates: Partial<T>) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // 直接从 URL 派生当前值，不缓存（key 数量有限，重算成本可忽略）。
  const value: T = (() => {
    const result = { ...defaults }
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const fromUrl = searchParams.get(key as string)
      result[key] = (fromUrl ?? defaults[key]) as T[keyof T]
    }
    return result
  })()

  const setValues = useCallback(
    (updates: Partial<T>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const key of Object.keys(updates) as Array<keyof T>) {
        const next = updates[key]
        if (!next || next === defaults[key]) {
          params.delete(key as string)
        } else {
          params.set(key as string, next)
        }
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [searchParams, router, pathname, defaults],
  )

  return [value, setValues] as const
}