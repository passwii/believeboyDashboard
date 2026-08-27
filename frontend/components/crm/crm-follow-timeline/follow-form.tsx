'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { FOLLOW_TYPE_LABELS } from '@/lib/crm/enums/follow.enum'
import type { FollowType } from '@/lib/crm/types/follow'
import type { FollowFormValue } from './types'

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
    <div className="space-y-3 rounded-none border border-term-border bg-term-panel p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="font-mono text-xs uppercase tracking-wider text-term-muted">类型</Label>
          <Select value={type} onValueChange={(v) => setType(v as FollowType)}>
            <SelectTrigger className="h-8 w-28 rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {FOLLOW_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="font-mono text-xs uppercase tracking-wider text-term-muted">下次跟进</Label>
          <Input
            type="date"
            className="h-8 w-40 rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text"
            value={nextFollowAt}
            onChange={(e) => setNextFollowAt(e.target.value)}
          />
        </div>
      </div>
      <Textarea
        placeholder="记录本次跟进内容…"
        className="rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? '提交中…' : '添加跟进'}
        </Button>
      </div>
    </div>
  )
}
