'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import { FOLLOW_TYPE_LABELS } from '@/lib/crm/enums/follow.enum'
import { formatRelativeTime } from '@/lib/crm/method/format'
import { WarmCrmState, WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import type { WarmBadgeTone } from '@/components/dashboard-v2/warm-ledger/controls'
import { FollowForm } from './follow-form'
import type { CrmFollowTimelineProps, FollowFormValue } from './types'
import styles from './crm-follow-timeline-warm.module.css'

/** 跟进类型 → Warm 语义（visit 使用琥珀强调，电话/微信/邮件保持中性）。 */
const TYPE_TONE: Record<string, WarmBadgeTone> = {
  phone: 'accent',
  visit: 'accent',
  wechat: 'positive',
  email: 'neutral',
  note: 'neutral',
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
    <div className={styles.timeline}>
      <FollowForm allowedTypes={allowedTypes} onSubmit={handleSubmit} />

      {loading ? (
        <WarmCrmState kind="loading" title="加载跟进中…" />
      ) : follows.length === 0 ? (
        <WarmCrmState kind="empty" title="暂无跟进记录" />
      ) : (
        <ScrollArea className="h-[280px] pr-3">
          <ol className={styles.list}>
            {follows.map((f) => (
              <li key={f.id} className={styles.item}>
                <div className={styles.itemHeader}>
                  <WarmCrmStatusPill tone={TYPE_TONE[f.type] ?? 'neutral'}>
                    {FOLLOW_TYPE_LABELS[f.type]}
                  </WarmCrmStatusPill>
                  <span className={styles.time}>
                    {f.createdByName ?? '我'} · {formatRelativeTime(f.createdAt)}
                  </span>
                </div>
                <p className={styles.content}>{f.content}</p>
                {f.nextFollowAt && (
                  <p className={styles.nextFollow}>
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
