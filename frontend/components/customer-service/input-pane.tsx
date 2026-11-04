'use client'
import {
  WarmButton,
  WarmSegmentedControl,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import type { ScenarioPreset } from '@/lib/server/ai-chat'
import styles from './customer-service-warm.module.css'

const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
] as const

const LENGTH_OPTIONS = [
  { value: 'brief', label: '简报' },
  { value: 'standard', label: '标准' },
  { value: 'detailed', label: '详细' },
] as const

export function InputPane({
  scenario,
  freeText,
  setFreeText,
  guidedFields,
  setGuidedFields,
  language,
  setLanguage,
  length,
  setLength,
  onGenerate,
  isGenerating,
  canGenerate,
}: {
  scenario: ScenarioPreset | null
  freeText: string
  setFreeText: (v: string) => void
  guidedFields: Record<string, string>
  setGuidedFields: (v: Record<string, string>) => void
  language: 'zh' | 'en'
  setLanguage: (v: 'zh' | 'en') => void
  length: 'brief' | 'standard' | 'detailed'
  setLength: (v: 'brief' | 'standard' | 'detailed') => void
  onGenerate: () => void
  isGenerating: boolean
  canGenerate: boolean
}) {
  if (!scenario) return null

  return (
    <section className={styles.inputPanel} aria-label={scenario.label}>
      <div className={styles.inputBody}>
        {scenario.showFreeTextArea && (
          <div className={styles.field}>
            <label
              className={styles.fieldLabel}
              htmlFor="customer-service-free-text"
            >
              原始草稿 / 数据 / 零散想法
            </label>
            <textarea
              id="customer-service-free-text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="粘贴你的原始草稿 / 数据 / 零散想法…"
              className={`${styles.control} ${styles.freeText}`}
            />
          </div>
        )}
        {scenario.inputSchema.map((f) => (
          <div key={f.key} className={styles.field}>
            <label
              className={styles.fieldLabel}
              htmlFor={`customer-service-field-${f.key}`}
            >
              {f.label}
            </label>
            {f.type === 'textarea' ? (
              <textarea
                id={`customer-service-field-${f.key}`}
                value={guidedFields[f.key] ?? ''}
                onChange={(e) =>
                  setGuidedFields({ ...guidedFields, [f.key]: e.target.value })
                }
                placeholder={f.placeholder}
                className={`${styles.control} ${styles.textarea}`}
              />
            ) : (
              <input
                id={`customer-service-field-${f.key}`}
                value={guidedFields[f.key] ?? ''}
                onChange={(e) =>
                  setGuidedFields({ ...guidedFields, [f.key]: e.target.value })
                }
                placeholder={f.placeholder}
                className={styles.control}
              />
            )}
          </div>
        ))}
      </div>
      <div className={styles.controlsRow}>
        <WarmSegmentedControl
          ariaLabel="输出语言"
          value={language}
          options={LANGUAGE_OPTIONS}
          onChange={setLanguage}
          className={styles.languageControl}
        />
        <WarmSelect
          id="customer-service-length"
          label="篇幅"
          value={length}
          options={LENGTH_OPTIONS}
          onChange={(value) =>
            setLength(value as 'brief' | 'standard' | 'detailed')
          }
          className={styles.lengthSelect}
        />
        <WarmButton
          variant="primary"
          onClick={onGenerate}
          disabled={!canGenerate}
          loading={isGenerating}
          loadingLabel="正在生成客服文案"
          className={styles.generateButton}
        >
          {isGenerating ? '生成中…' : '生成'}
        </WarmButton>
      </div>
    </section>
  )
}
