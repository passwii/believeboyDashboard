'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeInsightStream,
  InsightHttpError,
  InsightStreamEndedError,
} from '@/lib/insight/sse'
import {
  getInsightOutputs,
  getInsightSnapshot,
  isInsightErrorPayload,
  isInsightEventType,
  type InsightContentDeltaEvent,
  type InsightErrorPayload,
  type InsightEvent,
  type InsightOutputs,
  type InsightRunDetail,
  type InsightRunRequest,
  type InsightRunStartResponse,
  type InsightRunStatus,
  type InsightSnapshot,
  type InsightStreamStatus,
} from '@/lib/insight/protocol'
import { InsightClient } from '@/lib/insight/client'
import {
  advanceInsightReveal,
  createInsightRevealState,
  enqueueInsightRevealDelta,
  normalizeInsightRevealOptions,
  revealAllInsightOutputs,
  revealedInsightOutputs,
  setInsightRevealTarget,
  type InsightRevealOptions,
  type InsightRevealState,
} from '@/lib/insight/reveal-queue'
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion'

export type InsightStreamClientStatus = InsightStreamStatus

export type UseInsightStreamOptions = {
  client?: InsightClient
  reconnectDelayMs?: number
  maxReconnectAttempts?: number
  /** 客户端 delta 批处理窗口（毫秒），默认 32ms */
  batchWindowMs?: number
  /**
   * 吐字节奏器（BLF-1072）。`false` 关闭（到达即整段可见），传对象可覆写档位
   * （见 `lib/insight/reveal-queue.ts`）。默认开启，`prefers-reduced-motion` 下自动关闭。
   */
  reveal?: false | Partial<InsightRevealOptions>
  onEvent?: (event: InsightEvent) => void
  onStatusChange?: (status: InsightStreamClientStatus) => void
}

export type UseInsightStreamResult = {
  status: InsightStreamClientStatus
  /** canonical run 阶段（后端权威），非传输层状态 */
  runStatus: InsightRunStatus | null
  stage: string | null
  progress: number | null
  runId: string | null
  attempt: number | null
  lastEventId: string | null
  /**
   * 已到达的全量文本（权威内容优先）。终态 / 落库读这份：它不参与吐字节奏，
   * 因此任何时刻都不会比服务端已经下发的正文少。
   */
  drafts: InsightOutputs
  /** 已吐字内容（节奏器逐帧推进的输出）；终态与权威内容到达时与 `drafts` 对齐 */
  partialDrafts: InsightOutputs
  snapshot: InsightSnapshot | null
  error: InsightErrorPayload | null
  backgroundMessage: string | null
  isDetached: boolean
  start: (request: InsightRunRequest) => Promise<InsightRunStartResponse>
  /** 接管已存在的 run（不带 run_id 的落库绑定），终态直接回读 detail，非终态按游标续流 */
  attach: (runId: string) => Promise<InsightRunDetail>
  cancel: () => Promise<void>
  retry: () => Promise<InsightRunStartResponse>
  detach: () => void
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5

/**
 * 全量文本（`drafts`）的批处理窗口。BLF-1072：可见吐字已交给帧驱动的节奏器，
 * 这个窗口只管「账面」——终态/落库要读的那份累积文本。32ms ≈ 2 帧，既让账面
 * 追得上线上（每窗口合并 ≥ 8 个 token 一次渲染），又不与节奏器抢渲染帧。
 */
const DEFAULT_BATCH_WINDOW_MS = 32
const BACKGROUND_CONTINUATION_MESSAGE = '已转入后台继续生成'

function currentTimeMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 帧句柄：浏览器是 rAF 的 number，降级定时器是 setTimeout 的句柄。 */
type FrameHandle = ReturnType<typeof setTimeout> | number

/** 帧调度：浏览器用 rAF；无 rAF 的环境（SSR / 老测试环境）降级到 16ms 定时器。 */
function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback)
  }
  return setTimeout(callback, 16)
}

function cancelFrame(handle: FrameHandle): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle as number)
    return
  }
  clearTimeout(handle)
}

export function useInsightStream(options: UseInsightStreamOptions = {}): UseInsightStreamResult {
  const clientRef = useRef(options.client ?? new InsightClient())
  const reconnectDelayRef = useRef(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
  const maxReconnectAttemptsRef = useRef(
    options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
  )
  const batchWindowRef = useRef(options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS)
  const reducedMotion = usePrefersReducedMotion()
  /** 节奏器档位与开关；reduced-motion 下直接显示，不做 drip。 */
  const revealOptionsRef = useRef<InsightRevealOptions>(normalizeInsightRevealOptions(null))
  const revealDisabledRef = useRef(false)
  revealOptionsRef.current = normalizeInsightRevealOptions(
    options.reveal === false ? null : options.reveal
  )
  revealDisabledRef.current = options.reveal === false || reducedMotion
  const revealStateRef = useRef<InsightRevealState>(createInsightRevealState())
  const revealFrameRef = useRef<FrameHandle | null>(null)
  const scheduleRevealRef = useRef<() => void>(() => {})
  const onEventRef = useRef(options.onEvent)
  const onStatusChangeRef = useRef(options.onStatusChange)
  onEventRef.current = options.onEvent
  onStatusChangeRef.current = options.onStatusChange

  const [status, setStatusState] = useState<InsightStreamClientStatus>('queued')
  const [runStatus, setRunStatus] = useState<InsightRunStatus | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<number | null>(null)
  const [lastEventId, setLastEventId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<InsightOutputs>({})
  /** 已吐字内容（节奏器输出）；终态/权威内容到达时与 `drafts` 对齐 */
  const [partialDrafts, setPartialDrafts] = useState<InsightOutputs>({})
  const [snapshot, setSnapshot] = useState<InsightSnapshot | null>(null)
  const [error, setError] = useState<InsightErrorPayload | null>(null)
  const [backgroundMessage, setBackgroundMessage] = useState<string | null>(null)
  const [isDetached, setIsDetached] = useState(false)

  const generationRef = useRef(0)
  const disposedRef = useRef(false)
  const runIdRef = useRef<string | null>(null)
  const requestRef = useRef<InsightRunRequest | null>(null)
  const lastEventIdRef = useRef<string | null>(null)
  const seenEventIdsRef = useRef(new Set<string>())
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const terminalRef = useRef(false)
  const detachedRef = useRef(false)
  const draftsRef = useRef<InsightOutputs>({})
  const snapshotRef = useRef<InsightSnapshot | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasPendingDraftsRef = useRef(false)

  const setStatus = useCallback((next: InsightStreamClientStatus) => {
    setStatusState(next)
    onStatusChangeRef.current?.(next)
  }, [])

  const resetReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const abortLocalStream = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const cancelRevealFrame = useCallback(() => {
    if (revealFrameRef.current === null) return
    cancelFrame(revealFrameRef.current)
    revealFrameRef.current = null
  }, [])

  const resetContent = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    cancelRevealFrame()
    revealStateRef.current = createInsightRevealState()
    hasPendingDraftsRef.current = false
    draftsRef.current = {}
    snapshotRef.current = null
    setDrafts({})
    setPartialDrafts({})
    setSnapshot(null)
  }, [cancelRevealFrame])

  /**
   * 排一帧吐字（BLF-1072）。每个 rAF 调一次：按 `drainHorizonMs` 匀速推进
   * 「已吐字」前缀，把成簇到达的 delta 摊平成连续吐字；余量没吐完就继续排帧，
   * 吐完自然停住（不会空转）。
   */
  const scheduleReveal = useCallback(() => {
    if (revealFrameRef.current !== null) return
    revealFrameRef.current = scheduleFrame(() => {
      revealFrameRef.current = null
      const advanced = advanceInsightReveal(
        revealStateRef.current,
        currentTimeMs(),
        revealOptionsRef.current
      )
      revealStateRef.current = advanced.state
      if (advanced.changed) setPartialDrafts(advanced.revealed)
      if (advanced.pending) scheduleRevealRef.current()
    })
  }, [])
  scheduleRevealRef.current = scheduleReveal

  /** 终态收尾：把节奏器里还没吐完的余量一次揭示，不让面板停在半句话上。 */
  const finishReveal = useCallback(() => {
    cancelRevealFrame()
    const next = revealAllInsightOutputs(revealStateRef.current)
    if (next === revealStateRef.current) return
    revealStateRef.current = next
    setPartialDrafts(revealedInsightOutputs(next))
  }, [cancelRevealFrame])

  /**
   * 把累积的 delta 一次性发布给 React（账面 `drafts`）。可见吐字由节奏器逐帧给出，
   * 这里只在批处理窗口（默认 32ms）结束时 setState，避免每个 token 触发一次渲染。
   */
  const flushDrafts = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (!hasPendingDraftsRef.current) return
    hasPendingDraftsRef.current = false
    setDrafts(draftsRef.current)
    // 关闭节奏器（reduced-motion / reveal:false）：可见内容跟着账面一起落地。
    if (revealDisabledRef.current) setPartialDrafts(draftsRef.current)
  }, [])

  const mergeOutputs = useCallback(
    (next: InsightOutputs) => {
      if (Object.keys(next).length === 0) return
      draftsRef.current = { ...draftsRef.current, ...next }
      hasPendingDraftsRef.current = true
      // 权威内容（snapshot / done / detail 回读）必须立刻整段可见，不等窗口也不逐字吐。
      for (const [slot, content] of Object.entries(next)) {
        revealStateRef.current = setInsightRevealTarget(revealStateRef.current, slot, content)
      }
      flushDrafts()
      setPartialDrafts(revealedInsightOutputs(revealStateRef.current))
    },
    [flushDrafts]
  )

  const mergeSnapshot = useCallback(
    (next: InsightSnapshot) => {
      snapshotRef.current = next
      setSnapshot(next)
      const outputs = getInsightOutputs(next) ?? next.outputs
      mergeOutputs(outputs)
    },
    [mergeOutputs]
  )

  const appendDelta = useCallback(
    (event: InsightContentDeltaEvent) => {
      if (!event.slot || !event.delta) return
      const current = draftsRef.current[event.slot] ?? ''
      draftsRef.current = { ...draftsRef.current, [event.slot]: current + event.delta }
      hasPendingDraftsRef.current = true
      // 到达只入队，不渲染：屏幕上吐多少字由节奏器逐帧决定（BLF-1072）。
      revealStateRef.current = enqueueInsightRevealDelta(
        revealStateRef.current,
        event.slot,
        event.delta,
        currentTimeMs()
      )
      if (revealDisabledRef.current) {
        // reduced-motion / 显式关闭：不 drip，交给账面窗口一起整段落地。
        revealStateRef.current = revealAllInsightOutputs(revealStateRef.current)
      } else {
        scheduleReveal()
      }
      if (flushTimerRef.current) return
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null
        flushDrafts()
      }, batchWindowRef.current)
    },
    [flushDrafts, scheduleReveal]
  )

  const applyEvent = useCallback(
    (event: InsightEvent) => {
      onEventRef.current?.(event)

      if (isInsightEventType(event, 'status')) {
        const canonical = toRunStatus(event.status)
        if (canonical) setRunStatus(canonical)
        setStage(typeof event.stage === 'string' ? event.stage : null)
        setProgress(typeof event.progress_percent === 'number' ? event.progress_percent : null)
        if (event.status === 'failed') {
          terminalRef.current = true
          finishReveal()
          setStatus('failed')
        } else if (event.status === 'cancelled') {
          terminalRef.current = true
          finishReveal()
          setStatus('cancelled')
        } else if (event.status === 'completed') {
          terminalRef.current = true
          finishReveal()
          setStatus('completed')
        } else if (event.status === 'queued' || event.status === 'pending') {
          setStatus('queued')
        } else {
          setStatus('live')
        }
        return
      }

      if (isInsightEventType(event, 'snapshot')) {
        const canonical = toRunStatus(event.status)
        if (canonical) setRunStatus(canonical)
        if (typeof event.stage === 'string') setStage(event.stage)
        if (typeof event.progress_percent === 'number') setProgress(event.progress_percent)
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) mergeSnapshot(eventSnapshot)
        else {
          const outputs = getInsightOutputs(event)
          if (outputs) mergeOutputs(outputs)
        }
        return
      }

      if (isInsightEventType(event, 'content.delta')) {
        appendDelta(event)
        return
      }

      if (isInsightEventType(event, 'content.snapshot')) {
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) {
          mergeSnapshot(eventSnapshot)
        } else {
          const outputs = getInsightOutputs(event)
          if (outputs) mergeOutputs(outputs)
          if (typeof event.slot === 'string' && typeof event.content === 'string') {
            mergeOutputs({ [event.slot]: event.content })
          }
        }
        return
      }

      if (isInsightEventType(event, 'done')) {
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) mergeSnapshot(eventSnapshot)
        const outputs = getInsightOutputs(event)
        if (outputs) mergeOutputs(outputs)
        finishReveal()
        terminalRef.current = true
        setRunStatus('completed')
        setProgress(100)
        setError(null)
        setStatus('completed')
        return
      }

      if (isInsightEventType(event, 'error') && isInsightErrorPayload(event.error)) {
        terminalRef.current = true
        finishReveal()
        const cancelled = event.status === 'cancelled' || event.error.code === 'CANCELLED'
        setRunStatus(cancelled ? 'cancelled' : 'failed')
        setError(event.error)
        setStatus(cancelled ? 'cancelled' : 'failed')
      }
    },
    [appendDelta, finishReveal, mergeOutputs, mergeSnapshot, setStatus]
  )

  const fail = useCallback(
    (candidate: unknown, fallbackCode = 'STREAM_FAILED') => {
      const payload = toInsightError(candidate, fallbackCode)
      terminalRef.current = true
      setError(payload)
      setStatus('failed')
    },
    [setStatus]
  )
  const connect = useCallback(
    async (expectedGeneration: number, reconnecting: boolean): Promise<void> => {
      const currentRunId = runIdRef.current
      if (
        !currentRunId ||
        expectedGeneration !== generationRef.current ||
        detachedRef.current ||
        disposedRef.current ||
        terminalRef.current
      ) {
        return
      }

      resetReconnectTimer()
      abortLocalStream()
      const controller = new AbortController()
      abortRef.current = controller
      setStatus(reconnecting ? 'reconnecting' : 'connecting')

      try {
        const response = await clientRef.current.stream(currentRunId, {
          signal: controller.signal,
          lastEventId: lastEventIdRef.current,
        })
        if (expectedGeneration !== generationRef.current || controller.signal.aborted) return
        setStatus('live')

        const result = await consumeInsightStream(response, {
          signal: controller.signal,
          seenEventIds: seenEventIdsRef.current,
          onEventId: (id) => {
            lastEventIdRef.current = id
            setLastEventId(id)
          },
          onEvent: (event) => {
            if (expectedGeneration !== generationRef.current) return
            applyEvent(event)
          },
        })

        if (expectedGeneration !== generationRef.current) return
        if (result.terminalEvent?.type === 'done' || result.terminalEvent?.type === 'error') {
          terminalRef.current = true
          return
        }
      } catch (candidate) {
        if (expectedGeneration !== generationRef.current) return
        if (controller.signal.aborted || isAbortError(candidate)) return
        if (terminalRef.current) return

        const retryable = isRetryableStreamError(candidate)
        if (retryable && reconnectAttemptRef.current < maxReconnectAttemptsRef.current) {
          reconnectAttemptRef.current += 1
          setStatus('reconnecting')
          const delay = reconnectDelayRef.current * 2 ** (reconnectAttemptRef.current - 1)
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null
            void connect(expectedGeneration, true)
          }, delay)
          return
        }

        fail(candidate)
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [abortLocalStream, applyEvent, fail, resetReconnectTimer, setStatus]
  )

  const beginRun = useCallback(
    async (request: InsightRunRequest, mode: 'start' | 'retry'): Promise<InsightRunStartResponse> => {
      resetReconnectTimer()
      abortLocalStream()
      const expectedGeneration = ++generationRef.current
      terminalRef.current = false
      reconnectAttemptRef.current = 0
      seenEventIdsRef.current = new Set<string>()
      lastEventIdRef.current = null
      setLastEventId(null)
      setError(null)
      setBackgroundMessage(null)
      detachedRef.current = false
      setIsDetached(false)
      if (mode === 'start') resetContent()
      setStatus('queued')
      requestRef.current = request

      try {
        const response = await clientRef.current.start(request)
        if (expectedGeneration !== generationRef.current || disposedRef.current) return response
        runIdRef.current = response.run_id
        setRunId(response.run_id)
        setAttempt(response.attempt)
        const started = getInsightOutputs(response)
        if (started) mergeOutputs(started)
        void connect(expectedGeneration, false)
        return response
      } catch (candidate) {
        if (expectedGeneration === generationRef.current) fail(candidate, 'START_FAILED')
        throw candidate
      }
    },
    [
      abortLocalStream,
      connect,
      fail,
      mergeOutputs,
      resetContent,
      resetReconnectTimer,
      setStatus,
    ]
  )

  const start = useCallback(
    (request: InsightRunRequest) => beginRun(request, 'start'),
    [beginRun]
  )

  /**
   * 接管一个已存在的 run。台账详情只拿到 run_id（绑定关系由后端落库），
   * 因此不能走 `start`。终态直接以 detail 的权威内容收尾、不再开流；
   * 非终态用 `resume.latest_event_id` 当游标续流，避免重放已渲染的 delta。
   */
  const attach = useCallback(
    async (nextRunId: string): Promise<InsightRunDetail> => {
      resetReconnectTimer()
      abortLocalStream()
      const expectedGeneration = ++generationRef.current
      terminalRef.current = false
      reconnectAttemptRef.current = 0
      seenEventIdsRef.current = new Set<string>()
      lastEventIdRef.current = null
      setLastEventId(null)
      setError(null)
      setBackgroundMessage(null)
      detachedRef.current = false
      setIsDetached(false)
      resetContent()
      setStatus('queued')
      runIdRef.current = nextRunId
      setRunId(nextRunId)

      let detail: InsightRunDetail
      try {
        detail = await clientRef.current.detail(nextRunId)
      } catch (candidate) {
        if (expectedGeneration === generationRef.current) fail(candidate, 'DETAIL_FAILED')
        throw candidate
      }
      if (expectedGeneration !== generationRef.current || disposedRef.current) return detail

      setAttempt(detail.attempt)
      const canonical = toRunStatus(detail.status)
      if (canonical) setRunStatus(canonical)
      setStage(typeof detail.stage === 'string' ? detail.stage : null)
      setProgress(typeof detail.progress_percent === 'number' ? detail.progress_percent : null)
      const outputs = getInsightOutputs(detail)
      if (outputs) mergeOutputs(outputs)
      if (isInsightErrorPayload(detail.error)) setError(detail.error)

      if (canonical === 'completed' || canonical === 'cancelled' || canonical === 'failed') {
        terminalRef.current = true
        setStatus(
          canonical === 'completed'
            ? 'completed'
            : canonical === 'cancelled'
              ? 'cancelled'
              : 'failed'
        )
        return detail
      }

      const cursor = detail.resume?.latest_event_id ?? null
      lastEventIdRef.current = cursor
      setLastEventId(cursor)
      void connect(expectedGeneration, false)
      return detail
    },
    [
      abortLocalStream,
      connect,
      fail,
      mergeOutputs,
      resetContent,
      resetReconnectTimer,
      setStatus,
    ]
  )

  const cancel = useCallback(async () => {
    resetReconnectTimer()
    const currentRunId = runIdRef.current
    ++generationRef.current
    terminalRef.current = true
    abortLocalStream()
    // 已收到的正文一次性吐完：取消不是「停在一半」的理由。
    finishReveal()
    // 本地取消对本消费端即权威：run 已进入终态，规范状态与传输状态一起落地，
    // 否则按规范状态取标签的调用方会一直显示「生成中」。
    setRunStatus('cancelled')
    if (!currentRunId) {
      setStatus('cancelled')
      return
    }

    try {
      await clientRef.current.cancel(currentRunId)
    } catch {
      // Local cancellation is authoritative for this consumer. The server may
      // already have reached a terminal state, so a failed cancel request does
      // not reopen the stream or replace the cancelled state.
    } finally {
      setStatus('cancelled')
    }
  }, [abortLocalStream, finishReveal, resetReconnectTimer, setStatus])

  const retry = useCallback(async () => {
    const currentRunId = runIdRef.current
    if (!currentRunId) {
      const request = requestRef.current
      if (!request) throw new Error('No Insight run to retry')
      return beginRun(request, 'retry')
    }

    resetReconnectTimer()
    abortLocalStream()
    const expectedGeneration = ++generationRef.current
    terminalRef.current = false
    reconnectAttemptRef.current = 0
    seenEventIdsRef.current = new Set<string>()
    lastEventIdRef.current = null
    setLastEventId(null)
    setError(null)
    setBackgroundMessage(null)
    detachedRef.current = false
    setIsDetached(false)
    resetContent()
    setStatus('queued')

    try {
      const response = await clientRef.current.retry(currentRunId)
      if (expectedGeneration !== generationRef.current || disposedRef.current) return response
      runIdRef.current = response.run_id
      setRunId(response.run_id)
      setAttempt(response.attempt)
      const restarted = getInsightOutputs(response)
      if (restarted) mergeOutputs(restarted)
      void connect(expectedGeneration, false)
      return response
    } catch (candidate) {
      if (expectedGeneration === generationRef.current) fail(candidate, 'RETRY_FAILED')
      throw candidate
    }
  }, [
    abortLocalStream,
    beginRun,
    connect,
    fail,
    mergeOutputs,
    resetContent,
    resetReconnectTimer,
    setStatus,
  ])
  const detach = useCallback(() => {
    resetReconnectTimer()
    ++generationRef.current
    abortLocalStream()
    finishReveal()
    detachedRef.current = true
    setIsDetached(true)
    setBackgroundMessage(BACKGROUND_CONTINUATION_MESSAGE)
  }, [abortLocalStream, finishReveal, resetReconnectTimer])

  /**
   * 挂载/卸载标记（BLF-1072）。
   *
   * 之前只在卸载时置 `true`，从不复位：React StrictMode（Next dev 默认开启）会把每个
   * effect 挂载→卸载→再挂载跑两遍，于是**第一次挂载的清理**就把 ref 永久钉成
   * `disposed`，之后 `connect()` / `attach()` 里的 `disposedRef.current` 守卫统统
   * 直接 return —— 开发环境下流永远连不上，面板停在「准备提交分析任务」。
   *
   * 在挂载时的 effect 体里复位即可：effect 重跑（含 StrictMode 的再次挂载）会先执行
   * 新 effect 体再执行下一次清理，语义仍是「当前这次挂载是否还活着」。
   */
  useEffect(() => {
    disposedRef.current = false
    return () => {
      resetReconnectTimer()
      cancelRevealFrame()
      disposedRef.current = true
      abortLocalStream()
    }
  }, [abortLocalStream, cancelRevealFrame, resetReconnectTimer])

  return {
    status,
    runStatus,
    stage,
    progress,
    runId,
    attempt,
    lastEventId,
    drafts,
    partialDrafts,
    snapshot,
    error,
    backgroundMessage,
    isDetached,
    start,
    attach,
    cancel,
    retry,
    detach,
  }
}

/** canonical run 状态白名单：只认后端下发的这 7 个，未知值返回 null。 */
const RUN_STATUS: Record<InsightRunStatus, true> = {
  queued: true,
  aggregating: true,
  generating: true,
  finalizing: true,
  completed: true,
  failed: true,
  cancelled: true,
}

function toRunStatus(value: unknown): InsightRunStatus | null {
  if (typeof value !== 'string') return null
  return Object.prototype.hasOwnProperty.call(RUN_STATUS, value) ? (value as InsightRunStatus) : null
}

function toInsightError(value: unknown, fallbackCode: string): InsightErrorPayload {
  if (isInsightErrorPayload(value)) return value
  if (value instanceof InsightHttpError) {
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable,
      retry_after_seconds: value.retryAfter,
      details: value.details,
    }
  }
  if (value instanceof Error) return { code: fallbackCode, message: value.message, retryable: false }
  return { code: fallbackCode, message: String(value), retryable: false }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError'
}

function isRetryableStreamError(value: unknown): boolean {
  if (value instanceof InsightStreamEndedError) return true
  if (value instanceof InsightHttpError) return value.retryable
  if (isAbortError(value)) return false
  return true
}
