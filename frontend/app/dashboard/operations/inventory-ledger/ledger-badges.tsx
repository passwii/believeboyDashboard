/**
 * Status badges + small shared atoms for the inventory-ledger page.
 * (BLF-428 前端重构：徽章从页面顶部移入总览区，与"这月数据可信吗"放一起)
 */

import { AlertTriangle, CheckCircle2, Clock4 } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { dispositionLabel } from './ledger-types'
import type { ConsistencyCheckResult, IntegrityCheck } from './ledger-types'
import styles from './inventory-ledger-warm.module.css'

export function IntegrityBadge({ integrity }: { integrity: IntegrityCheck }) {
  if (integrity.status === 'OK') {
    return (
      <WarmBadge tone="positive" className={styles.statusBadge}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        跨月连续性校验通过
      </WarmBadge>
    )
  }
  if (integrity.status === 'PENDING') {
    return (
      <WarmBadge tone="accent" className={styles.statusBadge}>
        <Clock4 className="h-3.5 w-3.5" />
        对比数据不完整，暂无法完整校验
      </WarmBadge>
    )
  }
  return (
    <WarmBadge tone="negative" className={styles.statusBadge}>
      <AlertTriangle className="h-3.5 w-3.5" />
      跨月连续性异常（{integrity.mismatch_count} 项）
    </WarmBadge>
  )
}

export function ConsistencyBadge({ consistency }: { consistency: ConsistencyCheckResult }) {
  if (consistency.status === 'OK') {
    return (
      <WarmBadge tone="positive" className={styles.statusBadge}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        双表对账通过（明细累加 = 汇总水位变动）
      </WarmBadge>
    )
  }
  if (consistency.status === 'PENDING') {
    return (
      <WarmBadge tone="accent" className={styles.statusBadge}>
        <Clock4 className="h-3.5 w-3.5" />
        本月无数据，暂无法对账
      </WarmBadge>
    )
  }
  return (
    <WarmBadge tone="negative" className={styles.statusBadge}>
      <AlertTriangle className="h-3.5 w-3.5" />
      双表对账异常（{consistency.mismatch_count} 项）
    </WarmBadge>
  )
}

export function DispositionBadge({ disposition }: { disposition: string }) {
  if (disposition === 'SELLABLE') {
    return (
      <WarmBadge tone="positive" className={styles.statusBadge}>
        可售
      </WarmBadge>
    )
  }
  return (
    <WarmBadge tone="accent" className={styles.statusBadge}>
      {dispositionLabel(disposition)}
    </WarmBadge>
  )
}

export function ChangeIndicator({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>
  if (value > 0) return <span className={styles.changePositive}>↑{value}</span>
  if (value < 0) return <span className={styles.changeNegative}>↓{Math.abs(value)}</span>
  return <span>—</span>
}
