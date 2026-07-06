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
 *  const [projectId, setProjectId] = useUrlParam('project', '')
 *  const [country, setCountry]     = useUrlParam('country', 'US', {
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