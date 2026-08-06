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
      <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        跨月连续性校验通过
      </Badge>
    )
  }
  if (integrity.status === 'PENDING') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-300 bg-yellow-50 text-yellow-700">
        <Clock4 className="h-3.5 w-3.5" />
        无上月数据，暂无法校验
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-red-300 bg-red-50 text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      跨月连续性异常（{integrity.mismatch_count} 项）
    </Badge>
  )
}

export function ConsistencyBadge({ consistency }: { consistency: ConsistencyCheckResult }) {
  if (consistency.status === 'OK') {
    return (
      <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        双表对账通过（明细累加 = 汇总水位变动）
      </Badge>
    )
  }
  if (consistency.status === 'PENDING') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-300 bg-yellow-50 text-yellow-700">
        <Clock4 className="h-3.5 w-3.5" />
        本月无数据，暂无法对账
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-red-300 bg-red-50 text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      双表对账异常（{consistency.mismatch_count} 项）
    </Badge>
  )
}

export function DispositionBadge({ disposition }: { disposition: string }) {
  if (disposition === 'SELLABLE') {
    return (
      <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700 text-xs">
        可售
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700 text-xs">
      {dispositionLabel(disposition)}
    </Badge>
  )
}

export function ChangeIndicator({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  if (value > 0) return <span className="text-green-600">↑{value}</span>
  if (value < 0) return <span className="text-red-600">↓{Math.abs(value)}</span>
  return <span className="text-muted-foreground">—</span>
}
