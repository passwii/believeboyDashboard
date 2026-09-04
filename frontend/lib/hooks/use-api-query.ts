'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { normalizeErrorMessage } from '@/lib/error-utils'

/**
 * useApiQuery — 统一的客户端请求 hook
 *
 * 设计目标：
 * - 默认 5s 短超时：避免长骨架屏
 * - 超时 / 网络错 → 自动重试 1 次（仅 1 次，避免对慢后端造成 2× 尖刺）
 * - 4xx/5xx → 不自动重试，立即暴露 error（语义明确，避免被滥用做"重试到 200"）
 * - 组件卸载 → 自动 abort，不弹错误
 * - deps 变化 → 自动重发请求
 * - 暴露 retry() 给 UI 接管手动重试（用于 StatusRetryButton 风格的错误态）
 */

export type ApiQueryErrorKind = 'timeout' | 'network' | 'server' | 'aborted'

export interface ApiQueryError {
  kind: ApiQueryErrorKind
  message: string
  status?: number
  /** 本次 query 累计尝试次数（1 = 没重试过，2 = 自动重试过 1 次） */
  attempts: number
}

export interface UseApiQueryOptions<T> {
  /** 触发刷新的依赖列表。任意一项变化会重发请求。 */
  deps?: ReadonlyArray<unknown>
  /** 单次请求超时（毫秒）。默认 5_000。传 0 表示禁用超时。 */
  timeoutMs?: number
  /** 是否在第一次超时/网络错时自动重试 1 次。默认 true。 */
  autoRetry?: boolean
  /** 是否启用（false 时不发请求）。默认 true。 */
  enabled?: boolean
  /** 错误回调（用于弹 toast）。注意：组件级 toast 与 retry 按钮的语义不同。 */
  onError?: (err: ApiQueryError) => void
}

export interface UseApiQueryResult<T> {
  data: T | undefined
  loading: boolean
  error: ApiQueryError | null
  /** 手动重试（重置 attempts 计数）。 */
  retry: () => void
}

const DEFAULT_TIMEOUT_MS = 5_000
const NETWORK_RETRY_DELAY_MS = 100

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true
  // fetchWithTimeout wraps AbortError as Error("请求超时…")
  return /超时|timeout/i.test(err.message)
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /fetch failed|failed to fetch|networkerror|network request failed|load failed|econnrefused|socket hang up/i.test(
    err.message
  )
}

function statusFromError(err: unknown): number | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    return (err as { status: number }).status
  }
  return undefined
}

export function useApiQuery<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: UseApiQueryOptions<T> = {}
): UseApiQueryResult<T> {
  const {
    deps = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    autoRetry = true,
    enabled = true,
    onError,
  } = options

  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ApiQueryError | null>(null)
  const [runNonce, setRunNonce] = useState(0)

  // Latest refs for the loader / callbacks so we don't have to put them in deps.
  const loaderRef = useRef(loader)
  const onErrorRef = useRef(onError)
  loaderRef.current = loader
  onErrorRef.current = onError

  // Track current run so stale loads don't clobber state.
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }

    // Cancel any in-flight request from a previous invocation.
    abortRef.current?.abort()
    const outerController = new AbortController()
    abortRef.current = outerController

    const myRunId = ++runIdRef.current

    setLoading(true)
    setError(null)

    const attempt = async (
      attemptNo: 1 | 2
    ): Promise<{ ok: true; value: T } | { ok: false; err: ApiQueryError }> => {
      const innerController = new AbortController()
      // Forward outer abort to inner
      const onOuterAbort = () => innerController.abort()
      outerController.signal.addEventListener('abort', onOuterAbort, { once: true })

      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => innerController.abort(), timeoutMs)
      }

      try {
        const value = await loaderRef.current(innerController.signal)
        return { ok: true, value }
      } catch (err) {
        if (outerController.signal.aborted) {
          return {
            ok: false,
            err: { kind: 'aborted', message: '请求已取消', attempts: attemptNo },
          }
        }
        if (isTimeoutError(err)) {
          return {
            ok: false,
            err: {
              kind: 'timeout',
              message: `请求超时（${timeoutMs / 1000}秒），请稍后重试`,
              attempts: attemptNo,
            },
          }
        }
        if (isNetworkError(err)) {
          return {
            ok: false,
            err: { kind: 'network', message: '网络异常，请稍后重试', attempts: attemptNo },
          }
        }
        const status = statusFromError(err)
        return {
          ok: false,
          err: {
            kind: 'server',
            message: normalizeErrorMessage(err, '请求失败'),
            status,
            attempts: attemptNo,
          },
        }
      } finally {
        if (timer) clearTimeout(timer)
        outerController.signal.removeEventListener('abort', onOuterAbort)
      }
    }

    // First attempt
    let result = await attempt(1)
    if (result.ok) {
      if (myRunId !== runIdRef.current) return
      setData(result.value)
      setLoading(false)
      return
    }

    const first = result.err
    // Auto-retry on timeout or network errors (avoid retrying on 4xx/5xx)
    if (
      autoRetry &&
      (first.kind === 'timeout' || first.kind === 'network') &&
      !outerController.signal.aborted
    ) {
      // Small backoff so we don't hammer the backend on the very next tick
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS))
      if (outerController.signal.aborted || myRunId !== runIdRef.current) return
      result = await attempt(2)
      if (result.ok) {
        if (myRunId !== runIdRef.current) return
        setData(result.value)
        setLoading(false)
        return
      }
    }

    const finalErr = result.ok ? first : result.err.attempts === 2 ? result.err : first
    if (myRunId !== runIdRef.current) return

    if (finalErr.kind === 'aborted') {
      // Component unmounted or deps changed; don't surface as error.
      return
    }

    setError(finalErr)
    setLoading(false)
    onErrorRef.current?.(finalErr)
  }, [autoRetry, enabled, timeoutMs])

  useEffect(() => {
    run()
    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, runNonce, ...deps])

  const retry = useCallback(() => {
    setRunNonce((n) => n + 1)
  }, [])

  return { data, loading, error, retry }
}
