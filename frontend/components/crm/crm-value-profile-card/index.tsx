'use client'

/**
 * P6a 价值画像卡：4 维 ABCD 评分展示 + 编辑 + 综合档预览。
 * 嵌入客户详情抽屉顶部。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { HelpCircle } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import {
  SCORE_FIELDS,
  GRADE_OPTIONS,
  GRADE_COLOR,
  computeRating,
  type Grade,
  type ScoreKey,
} from '@/lib/crm/constants/value-score'
import type { Customer, ValueScoresInput } from '@/lib/crm/types/customer'

const KEY_TO_CUST: Record<ScoreKey, keyof Customer> = {
  score_scale: 'scoreScale',
  score_pay: 'scorePay',
  score_fit: 'scoreFit',
  score_coop: 'scoreCoop',
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
    <div className="space-y-3 rounded-none border border-term-border bg-term-panel p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-term-text">
          <span className="font-mono text-xs uppercase tracking-wider text-term-muted">价值画像</span>
          {customer.rating ? (
            <Badge className={GRADE_COLOR[customer.rating as Grade]} variant="secondary">
              综合档 {customer.rating}
            </Badge>
          ) : (
            <span className="font-mono text-xs text-term-faint">评分待完善</span>
          )}
          {editing && liveRating && liveRating !== customer.rating && (
            <Badge variant="outline" className="font-mono text-xs">
              预览 {liveRating}
            </Badge>
          )}
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            编辑评分
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SCORE_FIELDS.map((f) => {
          const cur = editing ? draft[f.key] : (customer[KEY_TO_CUST[f.key]] as Grade | null)
          return (
            <div key={f.key} className="flex items-center gap-2 text-sm text-term-text">
              <span className="font-mono text-xs text-term-muted">{f.label}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p>{f.tooltip}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {editing ? (
                <div className="ml-auto flex gap-0.5" role="radiogroup" aria-label={f.label}>
                  {GRADE_OPTIONS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      role="radio"
                      aria-label={g}
                      aria-checked={cur === g}
                      onClick={() => setDraft((d) => ({ ...d, [f.key]: g }))}
                      className={`h-6 w-6 rounded-none border text-xs font-medium transition-colors ${
                        cur === g
                          ? 'border-term-border bg-term-raised text-term-text'
                          : 'border-term-border bg-term-bg text-term-muted hover:bg-term-hover'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              ) : cur ? (
                <Badge variant="secondary" className={`ml-auto font-mono ${GRADE_COLOR[cur]}`}>
                  {cur}
                </Badge>
              ) : (
                <span className="ml-auto font-mono text-xs text-term-faint">—</span>
              )}
            </div>
          )
        })}
      </div>

      {editing && (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false)
              resetDraft()
            }}
          >
            取消
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存评分'}
          </Button>
        </div>
      )}
    </div>
  )
}