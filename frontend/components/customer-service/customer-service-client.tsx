'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import type { ScenarioSummary } from '@/lib/server/ai-chat'
import { findScenarioPreset } from '@/lib/server/ai-chat'
import { ScenarioTabs } from './scenario-tabs'
import { InputPane } from './input-pane'
import { ToneCard } from './tone-card'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import styles from './customer-service-warm.module.css'

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
  const [loadingScenarios, setLoadingScenarios] = useState(true)
  const [scenarioError, setScenarioError] = useState<string | null>(null)
  const streamingCount = useRef(0)
  const reqIdRef = useRef(0)

  const handleStreaming = (active: boolean) => {
    streamingCount.current += active ? 1 : -1
    if (streamingCount.current < 0) streamingCount.current = 0
    setIsGenerating(streamingCount.current > 0)
  }

  const loadScenarios = useCallback(async (force = false) => {
    setLoadingScenarios(true)
    setScenarioError(null)
    try {
      const config = await ensureConfigLoaded(force)
      const list = config.scenarios ?? []
      setScenarios(list)
      setSelectedId((current) => {
        if (list.some((scenario) => scenario.id === current && !scenario.disabled)) return current
        return list.find((scenario) => !scenario.disabled)?.id ?? current
      })
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : '加载场景配置失败')
    } finally {
      setLoadingScenarios(false)
    }
  }, [])

  useEffect(() => {
    void loadScenarios()
  }, [loadScenarios])

  useHeaderRefresh(() => loadScenarios(true), { loading: loadingScenarios || isGenerating })

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
  const isInitialScenarioLoad = loadingScenarios && scenarios.length === 0

  const handleGenerate = () => {
    if (!canGenerate || isGenerating) return
    reqIdRef.current += 1
    setGenerateToken(reqIdRef.current)
  }

  return (
    <div className={styles.page} data-warm-customer-service="true">
      {scenarioError && (
        <p role="alert" className={styles.pageError}>
          场景配置刷新失败：{scenarioError}
        </p>
      )}
      {isInitialScenarioLoad ? (
        <p role="status" className={styles.scenarioLoading}>
          正在加载场景配置
        </p>
      ) : (
        <>
          <ScenarioTabs
            scenarios={scenarios}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className={styles.workspace} data-testid="customer-service-workspace">
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
            <div className={styles.outputPane}>
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
              {!scenario && <p className={styles.emptyState}>请选择一个场景。</p>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
