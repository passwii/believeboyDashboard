'use client'

import {
  WarmCrmStatusPill,
  type WarmCrmStatusTone,
} from '@/components/dashboard-v2/warm-ledger/crm'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TYPE_LABELS,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'

export const PROPOSAL_STATUS_TONE: Record<ProposalStatus, WarmCrmStatusTone> = {
  draft: 'accent',
  published: 'positive',
  archived: 'neutral',
}

/** @deprecated 使用 PROPOSAL_STATUS_TONE。保留旧名称与旧值以避免调用方断路。 */
export const PROPOSAL_STATUS_TERM: Record<
  ProposalStatus,
  'warn' | 'pos' | 'muted'
> = {
  draft: 'warn',
  published: 'pos',
  archived: 'muted',
}

export function ProposalStatusPill({ status }: { status: ProposalStatus }) {
  return (
    <WarmCrmStatusPill tone={PROPOSAL_STATUS_TONE[status] ?? 'neutral'}>
      {PROPOSAL_STATUS_LABELS[status] ?? status}
    </WarmCrmStatusPill>
  )
}

export function ProposalTypePill({ type }: { type: ProposalType }) {
  return <WarmCrmStatusPill>{PROPOSAL_TYPE_LABELS[type] ?? type}</WarmCrmStatusPill>
}
