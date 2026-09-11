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
export type InsightStreamClientStatus = InsightStreamStatus

export type UseInsightStreamOptions = {
  client?: InsightClient
  reconnectDelayMs?: number
  maxReconnectAttempts?: number
  /** 客户端 delta 批处理窗口（毫秒），默认 64ms */
  batchWindowMs?: number
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
  drafts: InsightOutputs
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
const DEFAULT_BATCH_WINDOW_MS = 64
const BACKGROUND_CONTINUATION_MESSAGE = '已转入后台继续生成'

export function useInsightStream(options: UseInsightStreamOptions = {}): UseInsightStreamResult {
  const clientRef = useRef(options.client ?? new InsightClient())
  const reconnectDelayRef = useRef(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
  const maxReconnectAttemptsRef = useRef(
    options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
  )
  const batchWindowRef = useRef(options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS)
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

  const resetContent = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    hasPendingDraftsRef.current = false
    draftsRef.current = {}
    snapshotRef.current = null
    setDrafts({})
    setPartialDrafts({})
    setSnapshot(null)
  }, [])

  /**
   * 把累积的 delta 一次性发布给 React。真实 delta 仍逐条落到 ref，只在批处理
   * 窗口（默认 64ms）结束时 setState，避免每个 token 触发一次渲染。
   */
  const flushDrafts = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (!hasPendingDraftsRef.current) return
    hasPendingDraftsRef.current = false
    setDrafts(draftsRef.current)
    setPartialDrafts(draftsRef.current)
  }, [])

  const mergeOutputs = useCallback(
    (next: InsightOutputs) => {
      if (Object.keys(next).length === 0) return
      draftsRef.current = { ...draftsRef.current, ...next }
      hasPendingDraftsRef.current = true
      // 权威内容（snapshot / done / content.snapshot）必须立刻可见，不等窗口。
      flushDrafts()
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
      if (flushTimerRef.current) return
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null
        flushDrafts()
      }, batchWindowRef.current)
    },
    [flushDrafts]
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
          setStatus('failed')
        } else if (event.status === 'cancelled') {
          terminalRef.current = true
          setStatus('cancelled')
        } else if (event.status === 'completed') {
          terminalRef.current = true
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
        terminalRef.current = true
        setRunStatus('completed')
        setProgress(100)
        setError(null)
        setStatus('completed')
        return
      }

      if (isInsightEventType(event, 'error') && isInsightErrorPayload(event.error)) {
        terminalRef.current = true
        const cancelled = event.status === 'cancelled' || event.error.code === 'CANCELLED'
        setRunStatus(cancelled ? 'cancelled' : 'failed')
        setError(event.error)
        setStatus(cancelled ? 'cancelled' : 'failed')
      }
    },
    [appendDelta, mergeOutputs, mergeSnapshot, setStatus]
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
          canonical === 'completed' ? 'completed' : canonical === 'cancelled' ? 'cancelled' : 'failed'
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
  }, [abortLocalStream, resetReconnectTimer, setStatus])

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
    detachedRef.current = true
    setIsDetached(true)
    setBackgroundMessage(BACKGROUND_CONTINUATION_MESSAGE)
  }, [abortLocalStream, resetReconnectTimer])

  useEffect(() => {
    return () => {
      resetReconnectTimer()
      disposedRef.current = true
      abortLocalStream()
    }
  }, [abortLocalStream, resetReconnectTimer])

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
