'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { FOLLOW_TYPE_LABELS } from '@/lib/crm/enums/follow.enum'
import { formatRelativeTime } from '@/lib/crm/method/format'
import { FollowForm } from './follow-form'
import type { CrmFollowTimelineProps, FollowFormValue } from './types'

const TYPE_BADGE: Record<string, string> = {
  phone: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  visit: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  wechat: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  email: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  note: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
}

/** 跟进时间线（多态复用）：每个核心实体共用。 */
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
        <p className="py-6 text-center text-sm text-muted-foreground">加载跟进中…</p>
      ) : follows.length === 0 ? (
        <EmptyState message="暂无跟进记录" />
      ) : (
        <ScrollArea className="h-[280px] pr-3">
          <ol className="space-y-3">
            {follows.map((f) => (
              <li key={f.id} className="rounded-lg border border-border/60 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <Badge variant="secondary" className={`font-normal ${TYPE_BADGE[f.type] ?? ''}`}>
                    {FOLLOW_TYPE_LABELS[f.type]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {f.createdByName ?? '我'} · {formatRelativeTime(f.createdAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{f.content}</p>
                {f.nextFollowAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
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
