'use client'

import { useEffect, useRef, useState } from 'react'

import { useInsightStream } from '@/hooks/use-insight-stream'
import { InsightClient } from '@/lib/insight/client'
import {
  DOMAIN_START_FAILED,
  startDomainRun,
  toDomainStartError,
  type StartDomainRunOptions,
} from '@/lib/insight/domain-runs'
import {
  isInsightEventType,
  type InsightErrorPayload,
  type InsightRunStartResponse,
  type InsightRunStatus,
  type InsightStreamStatus,
} from '@/lib/insight/protocol'

/**
 * 「业务口径 → 域 run → 共享流」的通用胶水层（BLF-1017）。
 *
 * 域适配器只提供两样东西：口径入参（`input`，域端点负责组装 slots）和输出槽名
 * （`slot`）。提交、detail 回读、SSE 订阅、断流重连、后台完成、cancel、retry
 * 全在 `useInsightStream` 里，本 hook 不复制任何一份流生命周期，也不解析 SSE。
 *
 * 同一个口径只提交一次：口径（序列化后）变化或入口重新打开才会再提交；域端点
 * 自带幂等键，重复提交只会 replay 同一个 run。
 */

const DEFAULT_RECONNECT_DELAY_MS = 1_000

/** 测试注入用；默认走 Next 代理下的域端点。 */
export type DomainRunStarter<TInput> = (
  path: string,
  input: TInput,
  options?: StartDomainRunOptions
) => Promise<InsightRunStartResponse>

export type UseInsightDomainRunOptions<TInput> = {
  /** 入口（弹窗/页面）是否打开；关闭只断开本地订阅，服务端 run 继续跑 */
  open: boolean
  /** 域提交端点（Next 代理路径） */
  path: string
  /** 域口径；null 表示口径不全，不提交并提示 */
  input: TInput | null
  /** 口径不全时的可读提示 */
  incompleteMessage: string
  /** 域冻结的输出槽名（run 正文所在槽） */
  slot: string
  startRun?: DomainRunStarter<TInput>
  /** 测试注入；默认走 Next 代理下的 `/api/backend/v1/insight/runs` */
  client?: InsightClient
  reconnectDelayMs?: number
  /** run 进入终态（含后台完成）时回调，供父级刷新历史列表 */
  onSettled?: (status: InsightRunStatus) => void
}

export type InsightDomainRunFacts = {
  runId: string | null
  replayed: boolean
  submitting: boolean
  runStatus: InsightRunStatus | null
  /** 提交中视为 `connecting`，其余取共享 hook 的传输层状态 */
  transport: InsightStreamStatus
  progress: number | null
  /** 服务端 `done` 事件里的报告标题；terminal run 重开时可能为空 */
  title: string | null
  digest: string | null
  content: string
  contentState: 'draft' | 'final'
  error: InsightErrorPayload | null
  backgroundMessage: string | null
  /** 已存在可操作的 run：cancel/retry 才有对象 */
  actionable: boolean
  cancel: () => Promise<void>
  retry: () => Promise<InsightRunStartResponse>
}

export function useInsightDomainRun<TInput>(
  options: UseInsightDomainRunOptions<TInput>
): InsightDomainRunFacts {
  const { open, path, input, incompleteMessage, slot } = options
  const clientRef = useRef(options.client)
  if (!clientRef.current) clientRef.current = new InsightClient()
  const startRunRef = useRef<DomainRunStarter<TInput>>(options.startRun ?? startDomainRun)
  const onSettledRef = useRef(options.onSettled)
  onSettledRef.current = options.onSettled
  const inputRef = useRef(input)
  inputRef.current = input

  const [runId, setRunId] = useState<string | null>(null)
  const [replayed, setReplayed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [startError, setStartError] = useState<InsightErrorPayload | null>(null)
  const [digest, setDigest] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const submittedRef = useRef<string | null>(null)
  const submitAbortRef = useRef<AbortController | null>(null)
  const settledRef = useRef<string | null>(null)

  const stream = useInsightStream({
    client: clientRef.current,
    reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    onEvent: (event) => {
      if (isInsightEventType(event, 'done')) {
        if (typeof event.content_sha256 === 'string') setDigest(event.content_sha256)
        if (typeof event.title === 'string' && event.title.trim()) setTitle(event.title)
      }
    },
  })
  const attach = stream.attach
  const detach = stream.detach

  // 口径序列化后作为提交键：`input` 每次渲染都是新对象，只有内容变化才算新口径。
  const submitKey = open && input ? `${path}:${JSON.stringify(input)}` : null
  /** 入口开着但口径不全：提交键缺位，必须显式提示缺什么，不能静默空转。 */
  const incomplete = open && input === null

  useEffect(() => {
    if (!submitKey) {
      submittedRef.current = null
      submitAbortRef.current?.abort()
      submitAbortRef.current = null
      setSubmitting(false)
      setRunId(null)
      setReplayed(false)
      setDigest(null)
      setTitle(null)
      settledRef.current = null
      setStartError(
        incomplete
          ? { code: DOMAIN_START_FAILED, message: incompleteMessage, retryable: false }
          : null
      )
      detach()
      return
    }
    if (submittedRef.current === submitKey) return
    submittedRef.current = submitKey
    setStartError(null)
    setDigest(null)
    setTitle(null)
    settledRef.current = null

    // submitKey 非空即口径完整；这里只做类型收窄（提交期间口径可变，故读 ref）。
    const currentInput = inputRef.current
    if (!currentInput) return

    const controller = new AbortController()
    submitAbortRef.current = controller
    setSubmitting(true)
    startRunRef
      .current(path, currentInput, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        setRunId(response.run_id)
        setReplayed(Boolean(response.replayed))
        // 建 run 之后的读路径全在共享 hook：detail 回读 + SSE + 重连 + retry + cancel。
        // 终态 run 的 `done` 事件不会重放，标题从 detail 的权威字段取回。
        void attach(response.run_id)
          .then((detail) => {
            if (typeof detail.title === 'string' && detail.title.trim()) setTitle(detail.title)
          })
          .catch(() => undefined)
      })
      .catch((candidate: unknown) => {
        if (controller.signal.aborted) return
        setStartError(toDomainStartError(candidate))
      })
      .finally(() => {
        if (submitAbortRef.current !== controller) return
        submitAbortRef.current = null
        setSubmitting(false)
      })
  }, [submitKey, incomplete, incompleteMessage, path, attach, detach])

  const runStatus = stream.runStatus
  useEffect(() => {
    if (!runId || !runStatus) return
    if (runStatus !== 'completed' && runStatus !== 'failed' && runStatus !== 'cancelled') return
    const key = `${runId}:${runStatus}`
    if (settledRef.current === key) return
    settledRef.current = key
    onSettledRef.current?.(runStatus)
  }, [runId, runStatus])

  useEffect(() => {
    return () => {
      submitAbortRef.current?.abort()
    }
  }, [])

  const streamError = stream.error
  const attachedRunId = stream.runId

  return {
    runId,
    replayed,
    submitting,
    runStatus,
    transport: submitting ? 'connecting' : stream.status,
    progress: stream.progress,
    title,
    digest,
    content: stream.drafts[slot] ?? '',
    contentState: runStatus === 'completed' ? 'final' : 'draft',
    error: startError ?? streamError,
    // 提交失败时 run 根本不存在，backgroundMessage 语义不成立。
    backgroundMessage: startError ? null : stream.backgroundMessage,
    actionable: attachedRunId !== null && !startError,
    cancel: stream.cancel,
    retry: stream.retry,
  }
}
