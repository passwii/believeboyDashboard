'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useChatStream, type UseChatStreamCallbacks } from '@/components/chat/hooks/use-chat-stream'
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
  const { send, isStreaming } = useChatStream(convIdRef, callbacksRef)

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
    <Card className='shrink-0'>
      <CardHeader className='flex flex-row items-center justify-between gap-2 space-y-0 pb-2'>
        <div>
          <CardTitle className='text-sm'>{tone.label}</CardTitle>
          <p className='text-xs text-muted-foreground'>{tone.description}</p>
        </div>
        <div className='flex gap-1'>
          <Button size='sm' variant='ghost' onClick={copy} disabled={!output}>复制</Button>
          <Button size='sm' variant='ghost' onClick={exportMd} disabled={!output}>导出</Button>
          <Button size='sm' variant='outline' onClick={() => void generate()} disabled={isStreaming}>重生成</Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className='text-sm text-destructive'>{error}</p>
        ) : isStreaming && !output ? (
          <div className='space-y-2'><Skeleton className='h-4 w-full' /><Skeleton className='h-4 w-5/6' /></div>
        ) : (
          <div className='whitespace-pre-wrap text-sm leading-relaxed'>
            {output || <span className='text-muted-foreground'>点击「生成」后在此查看{tone.label}。</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
