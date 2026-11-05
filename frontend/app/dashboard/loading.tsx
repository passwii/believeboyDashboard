'use client'

import { usePathname } from 'next/navigation'

import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'
import { WarmLedgerShell } from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell'

/** V4 Warm Ledger route-level skeleton. */
export default function DashboardV2Loading() {
  const pathname = usePathname()

  if (pathname === '/dashboard') {
    return (
      <WarmLedgerShell>
        <WarmRouteLoading label="正在加载运营总览" />
      </WarmLedgerShell>
    )
  }

  return <WarmRouteLoading />
}
