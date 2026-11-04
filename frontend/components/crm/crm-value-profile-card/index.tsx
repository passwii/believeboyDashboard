'use client'

/**
 * P6a 价值画像卡：4 维 ABCD 评分展示 + 编辑 + 综合档预览。
 * 嵌入客户详情抽屉顶部。
 */
import { useState } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { HelpCircle } from 'lucide-react'
import {
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import {
  SCORE_FIELDS,
  GRADE_OPTIONS,
  computeRating,
  type Grade,
  type ScoreKey,
} from '@/lib/crm/constants/value-score'
import type { Customer, ValueScoresInput } from '@/lib/crm/types/customer'
import styles from './crm-value-profile-card-warm.module.css'

const KEY_TO_CUST: Record<ScoreKey, keyof Customer> = {
  score_scale: 'scoreScale',
  score_pay: 'scorePay',
  score_fit: 'scoreFit',
  score_coop: 'scoreCoop',
}

const GRADE_TONE: Record<Grade, WarmBadgeTone> = {
  A: 'positive',
  B: 'accent',
  C: 'neutral',
  D: 'negative',
}

export function CrmValueProfileCard({
  customer,
  onSaved,
}: {
  customer: Customer
  onSaved?: (c: Customer) => void
}) {
  const client = useCrmClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<ScoreKey, Grade | null>>({
    score_scale: customer.scoreScale ?? null,
    score_pay: customer.scorePay ?? null,
    score_fit: customer.scoreFit ?? null,
    score_coop: customer.scoreCoop ?? null,
  })
  const [saving, setSaving] = useState(false)
  const liveRating = computeRating(draft)

  async function handleSave() {
    setSaving(true)
    try {
      const input: ValueScoresInput = {}
      for (const f of SCORE_FIELDS) {
        if (draft[f.key] !== customer[KEY_TO_CUST[f.key]]) input[f.key] = draft[f.key]
      }
      const updated = await client.updateValueScores(customer.id, input)
      onSaved?.(updated)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function resetDraft() {
    setDraft({
      score_scale: customer.scoreScale ?? null,
      score_pay: customer.scorePay ?? null,
      score_fit: customer.scoreFit ?? null,
      score_coop: customer.scoreCoop ?? null,
    })
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.header}>
          <span className={styles.title}>价值画像</span>
          {customer.rating ? (
            <WarmCrmStatusPill tone={GRADE_TONE[customer.rating as Grade] ?? 'neutral'}>
              综合档 {customer.rating}
            </WarmCrmStatusPill>
          ) : (
            <span className={styles.muted}>评分待完善</span>
          )}
          {editing && liveRating && liveRating !== customer.rating && (
            <WarmCrmStatusPill>预览 {liveRating}</WarmCrmStatusPill>
          )}
        </div>
        {!editing && (
          <WarmButton onClick={() => setEditing(true)}>
            编辑评分
          </WarmButton>
        )}
      </div>

      <div className={styles.grid}>
        {SCORE_FIELDS.map((f) => {
          const cur = editing ? draft[f.key] : (customer[KEY_TO_CUST[f.key]] as Grade | null)
          return (
            <div key={f.key} className={styles.scoreRow}>
              <span className={styles.scoreLabel}>{f.label}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className={styles.help} />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p>{f.tooltip}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {editing ? (
                <div className={styles.gradeOptions} role="radiogroup" aria-label={f.label}>
                  {GRADE_OPTIONS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      role="radio"
                      aria-label={g}
                      aria-checked={cur === g}
                      onClick={() => setDraft((d) => ({ ...d, [f.key]: g }))}
                      className={styles.option}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              ) : cur ? (
                <WarmCrmStatusPill className={styles.rating} tone={GRADE_TONE[cur]}>
                  {cur}
                </WarmCrmStatusPill>
              ) : (
                <span className={`${styles.rating} ${styles.muted}`}>—</span>
              )}
            </div>
          )
        })}
      </div>

      {editing && (
        <div className={styles.actions}>
          <WarmButton
            variant="quiet"
            onClick={() => {
              setEditing(false)
              resetDraft()
            }}
          >
            取消
          </WarmButton>
          <WarmButton variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存评分'}
          </WarmButton>
        </div>
      )}
    </div>
  )
}
