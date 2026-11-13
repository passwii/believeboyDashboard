'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Grid2X2, LayoutDashboard } from 'lucide-react'
import {
  SIDEBAR_TOP_GROUPS,
  filterByRole,
} from '@/lib/sidebar-config'
import { getDashboardRouteMeta } from '@/lib/dashboard-route-meta'
import {
  useWarmLedgerNavigation,
  type MobileNavigationDomain,
} from './warm-ledger-navigation'

const DOCK_DOMAINS: ReadonlyArray<{
  id: Exclude<MobileNavigationDomain, 'all'>
  label: string
}> = [
  { id: 'operations', label: '运营' },
  { id: 'reports', label: '报表' },
  { id: 'ai', label: 'AI' },
]

function getOwningGroupId(pathname: string) {
  const href = getDashboardRouteMeta(pathname)?.navHref ?? pathname
  return SIDEBAR_TOP_GROUPS.find((group) =>
    filterByRole(group.items).some(
      (item) =>
        item.url === href ||
        (item.matchPrefixes ?? []).some((prefix) => href.startsWith(prefix))
    )
  )?.id
}

function getDomainIcon(domain: Exclude<MobileNavigationDomain, 'all'>) {
  return SIDEBAR_TOP_GROUPS.find((group) => group.id === domain)?.icon
}

export function WarmLedgerMobileDock() {
  const pathname = usePathname() ?? ''
  const currentGroupId = getOwningGroupId(pathname)
  const {
    isDrawerOpen,
    mobileDomain,
    openNavigation,
    closeNavigation,
  } = useWarmLedgerNavigation()

  const renderDomainButton = (
    domain: MobileNavigationDomain,
    label: string,
    Icon: typeof Grid2X2
  ) => {
    const isCurrentDomain = domain !== 'all' && currentGroupId === domain
    const isExpanded = isDrawerOpen && mobileDomain === domain
    const accessibleLabel = isCurrentDomain ? `${label}，当前业务域` : label

    return (
      <button
        key={domain}
        type="button"
        className="warm-ledger__dock-item"
        aria-label={accessibleLabel}
        aria-controls="dashboard-sidebar"
        aria-expanded={isExpanded}
        data-current-domain={isCurrentDomain ? 'true' : undefined}
        onClick={(event) => {
          if (isExpanded) {
            closeNavigation()
            return
          }
          openNavigation(domain, event.currentTarget)
        }}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </button>
    )
  }

  return (
    <nav className="warm-ledger__mobile-dock" aria-label="移动主导航">
      <Link
        href="/dashboard"
        className="warm-ledger__dock-item"
        aria-current={pathname === '/dashboard' ? 'page' : undefined}
        aria-label="总览"
      >
        <LayoutDashboard aria-hidden="true" />
        <span>总览</span>
      </Link>

      {DOCK_DOMAINS.map(({ id, label }) => {
        const Icon = getDomainIcon(id)
        return Icon ? renderDomainButton(id, label, Icon) : null
      })}

      {renderDomainButton('all', '全部', Grid2X2)}
    </nav>
  )
}
