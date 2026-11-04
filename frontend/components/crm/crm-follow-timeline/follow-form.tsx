'use client'

import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { FOLLOW_TYPE_LABELS } from '@/lib/crm/enums/follow.enum'
import type { FollowType } from '@/lib/crm/types/follow'
import type { FollowFormValue } from './types'
import styles from './crm-follow-timeline-warm.module.css'

const ALL_TYPES: FollowType[] = ['phone', 'visit', 'wechat', 'email', 'note']

export function FollowForm({
  allowedTypes = ALL_TYPES,
  onSubmit,
}: {
  allowedTypes?: FollowType[]
  onSubmit: (value: FollowFormValue) => void | Promise<void>
}) {
  const [type, setType] = useState<FollowType>(allowedTypes[0] ?? 'phone')
  const [content, setContent] = useState('')
  const [nextFollowAt, setNextFollowAt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = content.trim().length > 0 && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSubmit({
        type,
        content: content.trim(),
        nextFollowAt: nextFollowAt || undefined,
      })
      setContent('')
      setNextFollowAt('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <WarmSelect
            id="follow-type"
            label="类型"
            value={type}
            options={allowedTypes.map((value) => ({
              value,
              label: FOLLOW_TYPE_LABELS[value],
            }))}
            onChange={(value) => setType(value as FollowType)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="follow-next-at">
            下次跟进
          </label>
          <input
            id="follow-next-at"
            type="date"
            className={styles.dateInput}
            value={nextFollowAt}
            onChange={(e) => setNextFollowAt(e.target.value)}
          />
        </div>
      </div>
      <Textarea
        placeholder="记录本次跟进内容…"
        className={styles.textarea}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
      />
      <div className={styles.actions}>
        <WarmButton variant="primary" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? '提交中…' : '添加跟进'}
        </WarmButton>
      </div>
    </div>
  )
}
