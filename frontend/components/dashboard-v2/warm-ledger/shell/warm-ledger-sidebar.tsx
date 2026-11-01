'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X } from 'lucide-react'
import { SIDEBAR_TOP_GROUPS, filterByRole } from '@/lib/sidebar-config'
import { WarmIconButton } from '../controls'
import { useWarmLedgerNavigation } from './warm-ledger-navigation'

const QUICK_LINK_TITLES = ['销售数据', '订单信息', '库存分析', '客户消息'] as const
const OVERVIEW_ICON = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'operations')?.icon

const primaryNavigation = SIDEBAR_TOP_GROUPS.flatMap((group) => {
  const firstItem = filterByRole(group.items)[0]
  if (!firstItem) return []

  return [
    {
      title: group.id === 'operations' ? firstItem.title : group.label,
      href: firstItem.url,
      icon: group.id === 'operations' ? firstItem.icon ?? group.icon : group.icon,
      routeMatches: [firstItem.url, ...(firstItem.matchPrefixes ?? [])],
    },
  ]
})

const quickLinks = QUICK_LINK_TITLES.flatMap((title) => {
  for (const group of SIDEBAR_TOP_GROUPS) {
    const item = filterByRole(group.items).find((entry) => entry.title === title)
    if (item) {
      return [
        {
          title: item.title,
          href: item.url,
          icon: item.icon ?? group.icon,
          routeMatches: [item.url, ...(item.matchPrefixes ?? [])],
        },
      ]
    }
  }
  return []
})

function isCurrentRoute(pathname: string, routes: string[]) {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

export function WarmLedgerSidebar() {
  const pathname = usePathname() ?? ''
  const { isMobile, isDrawerOpen, sidebarRef, closeNavigation } = useWarmLedgerNavigation()

  const closeAfterNavigation = () => {
    if (isMobile && isDrawerOpen) closeNavigation()
  }

  return (
    <aside
      ref={sidebarRef}
      id="dashboard-sidebar"
      className="warm-ledger__sidebar"
      aria-label="主导航"
      aria-hidden={isMobile && !isDrawerOpen ? true : undefined}
    >
      <div className="warm-ledger__brand-row">
        <span className="warm-ledger__brand-mark" aria-hidden="true">
          B
        </span>
        <div className="warm-ledger__brand-copy">
          <span className="warm-ledger__brand-name">BelieveBoy</span>
          <span className="warm-ledger__brand-area">跨境运营中台</span>
        </div>
        <WarmIconButton
          className="warm-ledger__sidebar-close"
          aria-label="关闭导航"
          data-warm-ledger-close
          onClick={closeNavigation}
        >
          <X aria-hidden="true" />
        </WarmIconButton>
      </div>

      <nav
        id="main-navigation"
        className="warm-ledger__navigation"
        aria-label="业务域和快捷入口"
      >
        <span className="warm-ledger__nav-label">业务域</span>
        <div className="warm-ledger__nav-list">
          <Link
            href="/dashboard"
            className="warm-ledger__nav-item"
            aria-label="运营总览"
            title="运营总览"
            aria-current={pathname === '/dashboard' ? 'page' : undefined}
            onClick={closeAfterNavigation}
          >
            <span className="warm-ledger__nav-indicator" aria-hidden="true" />
            <span className="warm-ledger__nav-icon-wrap">
              {OVERVIEW_ICON ? <OVERVIEW_ICON aria-hidden="true" /> : null}
            </span>
            <span className="warm-ledger__nav-copy">运营总览</span>
          </Link>

          {primaryNavigation.map(({ title, href, icon: Icon, routeMatches }) => {
            const active = isCurrentRoute(pathname, routeMatches)
            return (
              <Link
                key={href}
                href={href}
                className="warm-ledger__nav-item"
                aria-label={title}
                title={title}
                aria-current={active ? 'page' : undefined}
                onClick={closeAfterNavigation}
              >
                <span className="warm-ledger__nav-indicator" aria-hidden="true" />
                <span className="warm-ledger__nav-icon-wrap">
                  <Icon aria-hidden="true" />
                </span>
                <span className="warm-ledger__nav-copy">{title}</span>
              </Link>
            )
          })}
        </div>

        <div className="warm-ledger__nav-separator" aria-hidden="true" />
        <span className="warm-ledger__nav-label">快捷入口</span>
        <div className="warm-ledger__quick-list">
          {quickLinks.map(({ title, href, icon: Icon, routeMatches }) => (
            <Link
              key={title}
              href={href}
              className="warm-ledger__quick-link"
              aria-label={title}
              title={title}
              aria-current={isCurrentRoute(pathname, routeMatches) ? 'page' : undefined}
              onClick={closeAfterNavigation}
            >
              <Icon aria-hidden="true" />
              <span>{title}</span>
            </Link>
          ))}
        </div>
      </nav>
    </aside>
  )
}
