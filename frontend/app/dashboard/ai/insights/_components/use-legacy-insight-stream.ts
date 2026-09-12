'use client'

/**
 * 旧洞察（`/ai-insights/{id}/stream`）兼容订阅 hook —— BLF-1017。
 *
 * 旧洞察页只保留这一条 legacy 订阅路径（历史数据的只读兼容），并把它封成
 * **单一 hook**：页面不再自己 `new EventSource`、不再在组件里累积正文、不再
 * 维护 sub_status / 重连 / 终态收尾。共享 `useInsightStream`（canonical
 * `/insight/runs/{id}/stream`）不适用于旧传输（帧类型为
 * `status|chunk|done|error|ping`，且 run id 是整型），但这里不复制共享层的流状态机：
 * 订阅、重连、终态收口都由本 hook / 共享 hook 承担，页面只消费结果。
 *
 * 帧载荷直接来自 `EventSource.onmessage`（`data:` 的 JSON 正文，不含 SSE 分帧），
 * 因此交给 `parseLegacyInsightFrame` 校验即可——不能再套一层分帧解析器。
 *
 * 旧后端的真实行为（见 `ai_insight.py::stream_insight`）：2s 轮询 DB，状态变化时
 * 发 `status` 帧，其余发 `ping`，终态发一次 `done` / `error`；正文只在终态帧里
 * 返回。若订阅时 run 已终态，立即回一帧终态 `status`。
 */

import { useEffect, useRef, useState } from 'react'

import type { InsightErrorPayload } from '@/lib/insight'

import {
  isLegacyTerminalStatus,
  legacyFrameSubStatus,
  parseLegacyInsightFrame,
  toLegacyPanelError,
  toLegacyPanelState,
  type LegacyInsightFrame,
  type LegacyPanelState,
  type LegacyRunTransport,
} from './legacy-insight-compat'

export function legacyInsightStreamPath(insightId: number): string {
  return `/api/backend/v1/ai-insights/${insightId}/stream`
}

export type LegacyInsightStreamOptions = {
  /** 订阅目标；null 表示没有可订阅的 run */
  insightId: number | null
  /** 是否订阅：弹窗关闭 / run 已终态即断开（旧 run 由后端继续跑，列表轮询兜底） */
  enabled: boolean
  /** 帧回调：父级据此同步列表、详情与通知（每帧调用，含终态帧） */
  onFrame?: (frame: LegacyInsightFrame) => void
  /** 首帧之前展示的子阶段（默认 `queued`） */
  initialSubStatus?: string | null
  /** 测试注入，默认 `new EventSource(url)` */
  createSource?: (url: string) => EventSource
}

export type LegacyInsightPanel = {
  state: LegacyPanelState
  content: string
  title: string | null
  error: InsightErrorPayload | null
  subStatus: string | null
  /** 已收到终态帧（done / error / failed status） */
  finished: boolean
}

export function useLegacyInsightStream(
  options: LegacyInsightStreamOptions
): LegacyInsightPanel {
  const { insightId, enabled, initialSubStatus = 'queued' } = options
  const [content, setContent] = useState('')
  const [title, setTitle] = useState<string | null>(null)
  const [subStatus, setSubStatus] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle')
  const [transport, setTransport] = useState<LegacyRunTransport>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onFrameRef = useRef(options.onFrame)
  onFrameRef.current = options.onFrame
  const createSourceRef = useRef(options.createSource)
  createSourceRef.current = options.createSource

  useEffect(() => {
    if (!enabled || insightId === null) {
      setTransport('idle')
      setStatus('idle')
      return
    }
    const createSource = createSourceRef.current
    if (!createSource && typeof EventSource === 'undefined') {
      // 环境无 EventSource（SSR / 未注入的测试环境）：不订阅、不伪造数据
      return
    }

    // 重新订阅等价于「从头重放」：清空上一轮累积，避免重连后正文重复。
    setContent('')
    setTitle(null)
    setErrorMessage(null)
    setSubStatus(initialSubStatus)
    setStatus('running')
    setTransport('live')

    const source = createSource
      ? createSource(legacyInsightStreamPath(insightId))
      : new EventSource(legacyInsightStreamPath(insightId))
    let closed = false
    let openedOnce = false

    const close = () => {
      if (closed) return
      closed = true
      source.close()
    }

    // 已终态的 run：断流后仍要能刷新列表 / 详情，故终态帧统一走 onFrame。
    const emit = (frame: LegacyInsightFrame) => {
      onFrameRef.current?.(frame)
    }

    const applyFrame = (frame: LegacyInsightFrame) => {
      if (frame.type === 'ping') return

      if (frame.type === 'chunk') {
        setContent((prev) => prev + frame.delta)
        return
      }

      if (frame.type === 'status') {
        const nextSubStatus = legacyFrameSubStatus(frame)
        if (nextSubStatus) setSubStatus(nextSubStatus)
        if (frame.content) setContent(frame.content)
        if (frame.title) setTitle(frame.title)
        if (frame.status === 'failed') {
          setErrorMessage(frame.error_message ?? '生成任务失败')
          setStatus('failed')
          setTransport('ended')
          close()
        } else if (frame.status === 'completed') {
          setStatus('completed')
          setTransport('ended')
          close()
        }
        emit(frame)
        return
      }

      if (frame.type === 'done') {
        if (frame.status === 'failed') {
          setErrorMessage(frame.error_message ?? '生成任务失败')
          setStatus('failed')
        } else {
          setStatus('completed')
        }
        if (frame.content) setContent(frame.content)
        if (frame.title) setTitle(frame.title)
        setSubStatus(null)
        setTransport('ended')
        close()
        emit(frame)
        return
      }

      // type === 'error'
      setErrorMessage(frame.error_message ?? frame.error)
      setStatus('failed')
      setSubStatus(null)
      setTransport('ended')
      close()
      emit(frame)
    }

    source.onmessage = (event: MessageEvent) => {
      const frame = parseLegacyInsightFrame(event.data)
      if (frame) applyFrame(frame)
    }

    source.onopen = () => {
      if (openedOnce) {
        // 浏览器自动重连成功：旧流从当前状态重放，清掉本地累积防止重复文本
        setContent('')
        setSubStatus(initialSubStatus)
      }
      openedOnce = true
      setTransport('live')
    }

    source.onerror = () => {
      if (closed) return
      // EventSource 自带重连：这里只反映传输态，终态仍由帧决定
      setTransport('reconnecting')
    }

    return () => {
      close()
    }
  }, [enabled, insightId, initialSubStatus])

  const finished = isLegacyTerminalStatus(status)
  return {
    state: toLegacyPanelState({ status, subStatus, transport }),
    content,
    title,
    error: toLegacyPanelError(errorMessage),
    subStatus,
    finished,
  }
}
