'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useChatStreamV2,
  type UseChatStreamCallbacks,
} from '@/components/chat/hooks/use-chat-stream-v2'
import { createConversation } from '@/lib/api/ai-chat'
import { buildUserContent } from './build-prompt'
import type { ScenarioField, ToneOption } from '@/lib/server/ai-chat'

type GenerateInput = {
  freeText: string
  guidedFields: Record<string, string>
  schema: ScenarioField[]
  scenarioId: string
  toneId: string
  language: 'zh' | 'en'
  length: 'brief' | 'standard' | 'detailed'
  onStreamingChange: (v: boolean) => void
}

export function ToneCard({
  scenarioId,
  tone,
  freeText,
  guidedFields,
  language,
  length,
  schema,
  generateToken,
  onStreamingChange,
}: {
  scenarioId: string
  tone: ToneOption
  freeText: string
  guidedFields: Record<string, string>
  language: 'zh' | 'en'
  length: 'brief' | 'standard' | 'detailed'
  schema: ScenarioField[]
  generateToken: number
  onStreamingChange: (v: boolean) => void
}) {
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const convIdRef = useRef<number | null>(null)
  const callbacksRef = useRef<UseChatStreamCallbacks>({
    onChunk: (delta: string) => setOutput((prev) => prev + delta),
    onDone: () => {
      setDone(true)
      onStreamingChange(false)
    },
    onError: (msg: string) => {
      setError(msg)
      onStreamingChange(false)
    },
  })
  const { send, isStreaming } = useChatStreamV2(convIdRef, callbacksRef)

  // 把所有 prop / state 同步到 latestRef，generate 内部读 ref 取最新值；
  // 这样 generate 的 useCallback 只依赖稳定的 `send`，effect 也无需 disable。
  const latestRef = useRef<GenerateInput>({
    freeText,
    guidedFields,
    schema,
    scenarioId,
    toneId: tone.id,
    language,
    length,
    onStreamingChange,
  })
  useEffect(() => {
    latestRef.current = {
      freeText,
      guidedFields,
      schema,
      scenarioId,
      toneId: tone.id,
      language,
      length,
      onStreamingChange,
    }
  }, [freeText, guidedFields, schema, scenarioId, tone.id, language, length, onStreamingChange])

  const generate = useCallback(async () => {
    const snap = latestRef.current
    setOutput('')
    setError(null)
    setDone(false)
    snap.onStreamingChange(true)
    const content = buildUserContent({
      freeText: snap.freeText,
      guidedFields: snap.guidedFields,
      schema: snap.schema,
    })
    const conv = await createConversation('客服交流')
    convIdRef.current = conv.id
    try {
      await send(content, {
        scenarioId: snap.scenarioId,
        toneId: snap.toneId,
        language: snap.language,
        length: snap.length,
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : '生成失败')
      snap.onStreamingChange(false)
    }
  }, [send])

  // generateToken 变化触发生成（>0 才触发）
  useEffect(() => {
    if (generateToken > 0) void generate()
  }, [generateToken, generate])

  const copy = () => {
    if (output) void navigator.clipboard.writeText(output)
  }
  const exportMd = () => {
    if (!output) return
    const blob = new Blob([output], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tone.label}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="flex min-w-0 shrink-0 flex-col rounded-none border border-term-border bg-term-panel shadow-none">
      <header className="flex shrink-0 flex-col gap-1 border-b border-term-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-term-text">{tone.label}</h3>
          <p className="text-xs leading-4 text-term-muted">{tone.description}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={copy} disabled={!output} className="h-7 rounded-none border border-transparent font-mono text-xs text-term-muted hover:border-term-border hover:text-term-text">
            复制
          </Button>
          <Button size="sm" variant="ghost" onClick={exportMd} disabled={!output} className="h-7 rounded-none border border-transparent font-mono text-xs text-term-muted hover:border-term-border hover:text-term-text">
            导出
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void generate()}
            disabled={isStreaming}
            className="h-7 rounded-none border-term-border bg-term-bg font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
          >
            重生成
          </Button>
        </div>
      </header>
      <div className="p-3">
        {error ? (
          <p className="text-sm text-term-neg">{error}</p>
        ) : isStreaming && !output ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full rounded-none border border-term-border" />
            <Skeleton className="h-4 w-5/6 rounded-none border border-term-border" />
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-sm leading-6 text-term-text">
            {output || (
              <span className="text-term-faint">点击「生成」后在此查看{tone.label}。</span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
