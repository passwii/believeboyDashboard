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
  type InsightContentDeltaEvent,
  type InsightErrorPayload,
  type InsightEvent,
  type InsightOutputs,
  type InsightRunRequest,
  type InsightRunStartResponse,
  type InsightRunStatus,
  type InsightSnapshot,
} from '@/lib/insight/protocol'
import { InsightClient } from '@/lib/insight/client'

export type InsightStreamClientStatus = Extract<
  InsightRunStatus,
  'queued' | 'connecting' | 'live' | 'reconnecting' | 'completed' | 'failed' | 'cancelled'
>

export type UseInsightStreamOptions = {
  client?: InsightClient
  reconnectDelayMs?: number
  maxReconnectAttempts?: number
  onEvent?: (event: InsightEvent) => void
  onStatusChange?: (status: InsightStreamClientStatus) => void
}

export type UseInsightStreamResult = {
  status: InsightStreamClientStatus
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
  cancel: () => Promise<void>
  retry: () => Promise<InsightRunStartResponse>
  detach: () => void
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
const BACKGROUND_CONTINUATION_MESSAGE = '已转入后台继续生成'

export function useInsightStream(options: UseInsightStreamOptions = {}): UseInsightStreamResult {
  const clientRef = useRef(options.client ?? new InsightClient())
  const reconnectDelayRef = useRef(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
  const maxReconnectAttemptsRef = useRef(
    options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
  )
  const onEventRef = useRef(options.onEvent)
  const onStatusChangeRef = useRef(options.onStatusChange)
  onEventRef.current = options.onEvent
  onStatusChangeRef.current = options.onStatusChange

  const [status, setStatusState] = useState<InsightStreamClientStatus>('queued')
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
  const runIdRef = useRef<string | null>(null)
  const attemptRef = useRef<number | null>(null)
  const requestRef = useRef<InsightRunRequest | null>(null)
  const lastEventIdRef = useRef<string | null>(null)
  const seenEventIdsRef = useRef(new Set<string>())
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const terminalRef = useRef(false)
  const draftsRef = useRef<InsightOutputs>({})
  const snapshotRef = useRef<InsightSnapshot | null>(null)

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
    draftsRef.current = {}
    snapshotRef.current = null
    setDrafts({})
    setPartialDrafts({})
    setSnapshot(null)
  }, [])

  const mergeOutputs = useCallback((next: InsightOutputs) => {
    if (Object.keys(next).length === 0) return
    draftsRef.current = { ...draftsRef.current, ...next }
    setDrafts(draftsRef.current)
    setPartialDrafts(draftsRef.current)
  }, [])

  const mergeSnapshot = useCallback(
    (next: InsightSnapshot) => {
      snapshotRef.current = next
      setSnapshot(next)
      const outputs = getInsightOutputs(next) ?? next.outputs
      mergeOutputs(outputs)
    },
    [mergeOutputs]
  )

  const appendDelta = useCallback((event: InsightContentDeltaEvent) => {
    if (!event.slot || !event.delta) return
    const current = draftsRef.current[event.slot] ?? ''
    const next = { ...draftsRef.current, [event.slot]: current + event.delta }
    draftsRef.current = next
    setDrafts(next)
    setPartialDrafts(next)
  }, [])

  const applyEvent = useCallback(
    (event: InsightEvent) => {
      onEventRef.current?.(event)

      if (event.type === 'status' && 'status' in event && typeof event.status === 'string') {
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

      if (event.type === 'snapshot') {
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) mergeSnapshot(eventSnapshot)
        else {
          const outputs = getInsightOutputs(event)
          if (outputs) mergeOutputs(outputs)
        }
        return
      }

      if (event.type === 'content.delta' && 'slot' in event && 'delta' in event) {
        const slot = event.slot
        const delta = event.delta
        if (typeof slot === 'string' && typeof delta === 'string') {
          appendDelta({ ...event, slot, delta })
        }
        return
      }

      if (event.type === 'content.snapshot') {
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) mergeSnapshot(eventSnapshot)
        else {
          const outputs = getInsightOutputs(event)
          if (outputs) mergeOutputs(outputs)
          if ('slot' in event && 'content' in event) {
            const slot = event.slot
            const content = event.content
            if (typeof slot === 'string' && typeof content === 'string') {
              mergeOutputs({ [slot]: content })
            }
          }
        }
        return
      }

      if (event.type === 'done') {
        const eventSnapshot = getInsightSnapshot(event)
        if (eventSnapshot) mergeSnapshot(eventSnapshot)
        const outputs = getInsightOutputs(event)
        if (outputs) mergeOutputs(outputs)
        terminalRef.current = true
        setError(null)
        setStatus('completed')
        return
      }

      if (event.type === 'error' && 'error' in event) {
        const candidate = event.error
        if (isInsightErrorPayload(candidate)) {
          terminalRef.current = true
          setError(candidate)
          setStatus('failed')
        }
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
      if (!currentRunId || expectedGeneration !== generationRef.current || isDetached || terminalRef.current) {
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
    [abortLocalStream, applyEvent, fail, isDetached, resetReconnectTimer, setStatus]
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
      setIsDetached(false)
      if (mode === 'start') resetContent()
      setStatus('queued')
      requestRef.current = request

      try {
        const response = await clientRef.current.start(request)
        if (expectedGeneration !== generationRef.current) return response
        runIdRef.current = response.run_id
        attemptRef.current = response.attempt
        setRunId(response.run_id)
        setAttempt(response.attempt)
        if (response.snapshot) mergeSnapshot(response.snapshot)
        void connect(expectedGeneration, false)
        return response
      } catch (candidate) {
        if (expectedGeneration === generationRef.current) fail(candidate, 'START_FAILED')
        throw candidate
      }
    },
    [abortLocalStream, connect, fail, mergeSnapshot, resetContent, resetReconnectTimer, setStatus]
  )

  const start = useCallback(
    (request: InsightRunRequest) => beginRun(request, 'start'),
    [beginRun]
  )

  const cancel = useCallback(async () => {
    resetReconnectTimer()
    const currentRunId = runIdRef.current
    ++generationRef.current
    terminalRef.current = true
    abortLocalStream()
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
    setIsDetached(false)
    resetContent()
    setStatus('queued')

    try {
      const response = await clientRef.current.retry(currentRunId)
      if (expectedGeneration !== generationRef.current) return response
      runIdRef.current = response.run_id
      attemptRef.current = response.attempt
      setRunId(response.run_id)
      setAttempt(response.attempt)
      if (response.snapshot) mergeSnapshot(response.snapshot)
      void connect(expectedGeneration, false)
      return response
    } catch (candidate) {
      if (expectedGeneration === generationRef.current) fail(candidate, 'RETRY_FAILED')
      throw candidate
    }
  }, [abortLocalStream, beginRun, connect, fail, mergeSnapshot, resetContent, resetReconnectTimer, setStatus])

  const detach = useCallback(() => {
    resetReconnectTimer()
    ++generationRef.current
    abortLocalStream()
    setIsDetached(true)
    setBackgroundMessage(BACKGROUND_CONTINUATION_MESSAGE)
  }, [abortLocalStream, resetReconnectTimer])

  useEffect(() => {
    return () => {
      resetReconnectTimer()
      ++generationRef.current
      abortLocalStream()
    }
  }, [abortLocalStream, resetReconnectTimer])

  return {
    status,
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
    cancel,
    retry,
    detach,
  }
  return typeof code === 'string' && typeof message === 'string'
}

function toInsightError(value: unknown, fallbackCode: string): InsightErrorPayload {
  if (isInsightErrorPayload(value)) return value
  if (value instanceof InsightHttpError) {
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable,
      retry_after: value.retryAfter,
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
