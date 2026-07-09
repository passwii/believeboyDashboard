'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ensureConfigLoaded, getConfig } from '@/lib/api/ai-chat-config-store'
import type { ScenarioSummary } from '@/lib/server/ai-chat'
import { findScenarioPreset } from '@/lib/server/ai-chat'
import { ScenarioTabs } from './scenario-tabs'
import { InputPane } from './input-pane'
import { ToneCard } from './tone-card'

const DRAFT_KEY = 'cs-draft-v1'

type Draft = {
  scenarioId: string
  freeText: string
  guidedFields: Record<string, string>
  language: 'zh' | 'en'
  length: 'brief' | 'standard' | 'detailed'
}

export function CustomerServiceClient() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [selectedId, setSelectedId] = useState('ops-report')
  const [freeText, setFreeText] = useState('')
  const [guidedFields, setGuidedFields] = useState<Record<string, string>>({})
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const [length, setLength] = useState<'brief' | 'standard' | 'detailed'>('standard')
  const [generateToken, setGenerateToken] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const streamingCount = useRef(0)
  const reqIdRef = useRef(0)

  const handleStreaming = (active: boolean) => {
    streamingCount.current += active ? 1 : -1
    if (streamingCount.current < 0) streamingCount.current = 0
    setIsGenerating(streamingCount.current > 0)
  }

  // 加载场景配置
  useEffect(() => {
    let alive = true
    ensureConfigLoaded()
      .then(() => {
        if (!alive) return
        const list = getConfig()?.scenarios ?? []
        setScenarios(list)
        const firstEnabled = list.find((s) => !s.disabled)
        if (firstEnabled) setSelectedId(firstEnabled.id)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 草稿暂存（sessionStorage）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY)
      if (raw) {
        const d = JSON.parse(raw) as Draft
        setSelectedId(d.scenarioId)
        setFreeText(d.freeText)
        setGuidedFields(d.guidedFields)
        setLanguage(d.language)
        setLength(d.length)
      }
    } catch {}
  }, [])
  useEffect(() => {
    const d: Draft = { scenarioId: selectedId, freeText, guidedFields, language, length }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d))
    } catch {}
  }, [selectedId, freeText, guidedFields, language, length])

  const scenario = useMemo(() => findScenarioPreset(selectedId), [selectedId])
  const canGenerate = Boolean(freeText.trim() || Object.values(guidedFields).some((v) => v.trim()))

  const handleGenerate = () => {
    if (!canGenerate || isGenerating) return
    reqIdRef.current += 1
    setGenerateToken(reqIdRef.current)
  }

  return (
    <div className='flex h-full flex-col gap-4'>
      <ScenarioTabs scenarios={scenarios} selectedId={selectedId} onSelect={setSelectedId} />
      <div className='grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2'>
        <InputPane
          scenario={scenario}
          freeText={freeText}
          setFreeText={setFreeText}
          guidedFields={guidedFields}
          setGuidedFields={setGuidedFields}
          language={language}
          setLanguage={setLanguage}
          length={length}
          setLength={setLength}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          canGenerate={canGenerate}
        />
        <div className='flex min-h-0 flex-col gap-3 overflow-y-auto pr-1'>
          {scenario?.toneOptions.map((tone) => (
            <ToneCard
              key={tone.id}
              scenarioId={scenario.id}
              tone={tone}
              freeText={freeText}
              guidedFields={guidedFields}
              language={language}
              length={length}
              schema={scenario.inputSchema}
              generateToken={generateToken}
              onStreamingChange={handleStreaming}
            />
          ))}
          {!scenario && <p className='text-sm text-muted-foreground'>请选择一个场景。</p>}
        </div>
      </div>
    </div>
  )
}
