'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/ui/empty-state'
import { FOLLOW_TYPE_LABELS } from '@/lib/crm/enums/follow.enum'
import { formatRelativeTime } from '@/lib/crm/method/format'
import { TermEnumPill, type TermTone } from '@/components/crm/term-shared'
import { FollowForm } from './follow-form'
import type { CrmFollowTimelineProps, FollowFormValue } from './types'

/** BLF-837：跟进类型 → 终端单色语义（call=accent · visit=warn · wechat=pos · email=info · note=muted）。 */
const TYPE_TONE: Record<string, TermTone> = {
  phone: 'accent',
  visit: 'warn',
  wechat: 'pos',
  email: 'info',
  note: 'muted',
}

/** 跟进时间线（多态复用）：每个核心实体共用（BLF-837 终端规格）。 */
export function CrmFollowTimeline({
  entityType,
  entityId,
  follows,
  loading,
  onSubmit,
  allowedTypes,
}: CrmFollowTimelineProps) {
  async function handleSubmit(value: FollowFormValue) {
    await onSubmit(value)
  }

  return (
    <div className="space-y-3">
      <FollowForm allowedTypes={allowedTypes} onSubmit={handleSubmit} />

      {loading ? (
        <p className="py-6 text-center font-mono text-xs text-term-faint">加载跟进中…</p>
      ) : follows.length === 0 ? (
        <EmptyState message="暂无跟进记录" />
      ) : (
        <ScrollArea className="h-[280px] pr-3">
          <ol className="space-y-2">
            {follows.map((f) => (
              <li key={f.id} className="border border-term-border p-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <TermEnumPill tone={TYPE_TONE[f.type] ?? 'muted'}>
                    {FOLLOW_TYPE_LABELS[f.type]}
                  </TermEnumPill>
                  <span className="font-mono text-xs tabular-nums text-term-faint">
                    {f.createdByName ?? '我'} · {formatRelativeTime(f.createdAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-term-text">
                  {f.content}
                </p>
                {f.nextFollowAt && (
                  <p className="mt-1 font-mono text-xs tabular-nums text-term-muted">
                    下次跟进：{new Date(f.nextFollowAt).toLocaleDateString('zh-CN')}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}
