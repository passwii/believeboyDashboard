'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  useChatStreamV2,
  type UseChatStreamCallbacks,
} from '@/components/chat/hooks/use-chat-stream-v2'
import { createConversation } from '@/lib/api/ai-chat'
import { buildUserContent } from './build-prompt'
import type { ScenarioField, ToneOption } from '@/lib/server/ai-chat'
import styles from './customer-service-warm.module.css'

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
  const [, setDone] = useState(false)
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
    try {
      const content = buildUserContent({
        freeText: snap.freeText,
        guidedFields: snap.guidedFields,
        schema: snap.schema,
      })
      const conv = await createConversation('客服交流')
      convIdRef.current = conv.id
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

  const headingId = `customer-service-tone-${tone.id}`

  return (
    <section
      className={styles.toneCard}
      aria-labelledby={headingId}
      aria-busy={isStreaming || undefined}
    >
      <header className={styles.toneHeader}>
        <div className={styles.toneHeading}>
          <h3 id={headingId} className={styles.toneTitle}>{tone.label}</h3>
          <p className={styles.toneDescription}>{tone.description}</p>
        </div>
        <div className={styles.toneActions}>
          <WarmButton
            variant="quiet"
            onClick={copy}
            disabled={!output}
            className={styles.compactAction}
          >
            复制
          </WarmButton>
          <WarmButton
            variant="quiet"
            onClick={exportMd}
            disabled={!output}
            className={styles.compactAction}
          >
            导出
          </WarmButton>
          <WarmButton
            variant="secondary"
            onClick={() => void generate()}
            loading={isStreaming}
            loadingLabel={`正在重新生成${tone.label}`}
            className={styles.compactAction}
          >
            重生成
          </WarmButton>
        </div>
      </header>
      <div className={styles.toneBody}>
        {error ? (
          <p role="alert" className={styles.toneError}>{error}</p>
        ) : isStreaming && !output ? (
          <div className={styles.loadingState}>
            <span className={styles.visuallyHidden} role="status">
              生成中…
            </span>
            <span className={`${styles.skeletonLine} ${styles.skeletonWide}`} />
            <span className={`${styles.skeletonLine} ${styles.skeletonShort}`} />
          </div>
        ) : (
          <div className={styles.toneOutput}>
            {output || (
              <span className={styles.tonePlaceholder}>
                点击「生成」后在此查看{tone.label}。
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
