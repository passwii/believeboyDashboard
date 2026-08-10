/**
 * Status badges + small shared atoms for the inventory-ledger page.
 * (BLF-428 前端重构：徽章从页面顶部移入总览区，与"这月数据可信吗"放一起)
 */

import { AlertTriangle, CheckCircle2, Clock4 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { dispositionLabel } from './ledger-types'
import type { ConsistencyCheckResult, IntegrityCheck } from './ledger-types'

export function IntegrityBadge({ integrity }: { integrity: IntegrityCheck }) {
  if (integrity.status === 'OK') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3.5 w-3.5" />
        跨月连续性校验通过
      </Badge>
    )
  }
  if (integrity.status === 'PENDING') {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock4 className="h-3.5 w-3.5" />
        无上月数据，暂无法校验
      </Badge>
    )
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="h-3.5 w-3.5" />
      跨月连续性异常（{integrity.mismatch_count} 项）
    </Badge>
  )
}

export function ConsistencyBadge({ consistency }: { consistency: ConsistencyCheckResult }) {
  if (consistency.status === 'OK') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3.5 w-3.5" />
        双表对账通过（明细累加 = 汇总水位变动）
      </Badge>
    )
  }
  if (consistency.status === 'PENDING') {
    return (
      <Badge variant="warning" className="gap-1">
        <Clock4 className="h-3.5 w-3.5" />
        本月无数据，暂无法对账
      </Badge>
    )
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="h-3.5 w-3.5" />
      双表对账异常（{consistency.mismatch_count} 项）
    </Badge>
  )
}

export function DispositionBadge({ disposition }: { disposition: string }) {
  if (disposition === 'SELLABLE') {
    return (
      <Badge variant="success" className="text-xs">
        可售
      </Badge>
    )
  }
  return (
    <Badge variant="warning" className="text-xs">
      {dispositionLabel(disposition)}
    </Badge>
  )
}

export function ChangeIndicator({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  if (value > 0) return <span className="text-[hsl(var(--data-positive))]">↑{value}</span>
  if (value < 0) return <span className="text-[hsl(var(--data-negative))]">↓{Math.abs(value)}</span>
  return <span className="text-muted-foreground">—</span>
}
