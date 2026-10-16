'use client'

import { TermEnumPill, type TermTone } from '@/components/crm/term-shared'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TYPE_LABELS,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'

/** 方案状态 → 终端语义（published=pos · archived=muted · draft=warn）。 */
export const PROPOSAL_STATUS_TERM: Record<ProposalStatus, TermTone> = {
  draft: 'warn',
  published: 'pos',
  archived: 'muted',
}

export function ProposalStatusPill({ status }: { status: ProposalStatus }) {
  return <TermEnumPill tone={PROPOSAL_STATUS_TERM[status] ?? 'muted'}>{PROPOSAL_STATUS_LABELS[status] ?? status}</TermEnumPill>
}

export function ProposalTypePill({ type }: { type: ProposalType }) {
  return <TermEnumPill tone="info">{PROPOSAL_TYPE_LABELS[type] ?? type}</TermEnumPill>
}
