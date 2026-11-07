'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X, type LucideIcon } from 'lucide-react'
import {
  SIDEBAR_TOP_GROUPS,
  filterByRole,
  type SidebarSubItem,
} from '@/lib/sidebar-config'
import { getDashboardRouteMeta } from '@/lib/dashboard-route-meta'
import { WarmIconButton } from '../controls'
import { useWarmLedgerNavigation } from './warm-ledger-navigation'

type WarmNavigationItem = {
  title: string
  href: string
  icon: LucideIcon
}

type WarmNavigationSection = {
  label: string
  items: WarmNavigationItem[]
}

const QUICK_LINK_TITLES = ['销售数据', '订单信息', '库存分析', '客户消息'] as const
const PORTFOLIO_ROUTE = '/dashboard/operations/portfolio-overview'
const PRODUCT_ANALYSIS_ROUTE = '/dashboard/reports/product-analysis'
const INVENTORY_FULFILLMENT_ROUTES = [
  '/dashboard/operations/inventory-ledger',
  '/dashboard/operations/shipping-plan',
  '/dashboard/operations/shipment-management',
  '/dashboard/operations/sku-info',
] as const
const PRIMARY_GROUP_IDS = new Set([
  'operations',
  'project-management',
  'reports',
  'advertising',
])
const WARM_SECTION_GROUP_IDS = ['finance', 'crm', 'ai', 'tools', 'system'] as const
const SYSTEM_EXTRA_ROUTES = ['/dashboard/system/agent-management'] as const
const OVERVIEW_ICON = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'operations')?.icon

function toNavigationItem(
  item: SidebarSubItem,
  groupIcon: LucideIcon
): WarmNavigationItem {
  return {
    title: item.title,
    href: item.url,
    icon: item.icon ?? groupIcon,
  }
}

function findConfiguredItem(url: string) {
  for (const group of SIDEBAR_TOP_GROUPS) {
    const item = filterByRole(group.items).find((entry) => entry.url === url)
    if (item) return { group, item }
  }
  return undefined
}

function getConfiguredGroupItems(groupId: string) {
  const group = SIDEBAR_TOP_GROUPS.find((entry) => entry.id === groupId)
  if (!group) return []
  return filterByRole(group.items).map((item) => toNavigationItem(item, group.icon))
}

const warmNavigationSections: WarmNavigationSection[] = WARM_SECTION_GROUP_IDS.map((groupId) => {
  const group = SIDEBAR_TOP_GROUPS.find((entry) => entry.id === groupId)
  const items = getConfiguredGroupItems(groupId)

  if (groupId !== 'system') {
    return { label: group?.label ?? groupId, items }
  }

  for (const route of SYSTEM_EXTRA_ROUTES) {
    const configured = findConfiguredItem(route)
    if (configured && !items.some((item) => item.href === route)) {
      items.push(toNavigationItem(configured.item, configured.group.icon))
    }
  }

  return { label: group?.label ?? groupId, items }
})

const primaryNavigation = SIDEBAR_TOP_GROUPS.flatMap((group) => {
  if (!PRIMARY_GROUP_IDS.has(group.id)) return []
  const firstItem = filterByRole(group.items)[0]
  if (!firstItem) return []

  return [
    {
      title: group.id === 'operations' ? firstItem.title : group.label,
      href: firstItem.url,
      icon: group.id === 'operations' ? firstItem.icon ?? group.icon : group.icon,
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
        },
      ]
    }
  }
  return []
})

const portfolioNavigation = SIDEBAR_TOP_GROUPS.flatMap((group) => {
  const item = filterByRole(group.items).find((entry) => entry.url === PORTFOLIO_ROUTE)
  if (!item) return []

  return [
    {
      title: item.title,
      href: item.url,
      icon: item.icon ?? group.icon,
    },
  ]
})

const productAnalysisNavigation = SIDEBAR_TOP_GROUPS.flatMap((group) => {
  const item = filterByRole(group.items).find((entry) => entry.url === PRODUCT_ANALYSIS_ROUTE)
  if (!item) return []

  return [
    {
      title: item.title,
      href: item.url,
      icon: item.icon ?? group.icon,
    },
  ]
})

const inventoryFulfillmentNavigation = INVENTORY_FULFILLMENT_ROUTES.flatMap((route) =>
  SIDEBAR_TOP_GROUPS.flatMap((group) => {
    const item = filterByRole(group.items).find((entry) => entry.url === route)
    if (!item) return []

    return [
      {
        title: item.title,
        href: item.url,
        icon: item.icon ?? group.icon,
      },
    ]
  })
)

function isCurrentRoute(pathname: string, href: string) {
  return (getDashboardRouteMeta(pathname)?.navHref ?? pathname) === href
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
        <div className="warm-ledger__navigation-scroll">
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

            {primaryNavigation.map(({ title, href, icon: Icon }) => {
              const active = isCurrentRoute(pathname, href)
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
            {productAnalysisNavigation.map(({ title, href, icon: Icon }) => {
              const active = isCurrentRoute(pathname, href)
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
            {portfolioNavigation.map(({ title, href, icon: Icon }) => {
              const active = isCurrentRoute(pathname, href)
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

          {warmNavigationSections.map((section) => (
            <Fragment key={section.label}>
              <div className="warm-ledger__nav-separator" aria-hidden="true" />
              <span className="warm-ledger__nav-label">{section.label}</span>
              <div className="warm-ledger__nav-list">
                {section.items.map(({ title, href, icon: Icon }) => {
                  const active = isCurrentRoute(pathname, href)
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
            </Fragment>
          ))}

          <div className="warm-ledger__nav-separator" aria-hidden="true" />
          <span className="warm-ledger__nav-label">库存与履约</span>
          <div className="warm-ledger__nav-list">
            {inventoryFulfillmentNavigation.map(({ title, href, icon: Icon }) => {
              const active = isCurrentRoute(pathname, href)
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
        </div>

        <div className="warm-ledger__quick-access">
          <div className="warm-ledger__nav-separator" aria-hidden="true" />
          <span className="warm-ledger__nav-label">快捷入口</span>
          <div className="warm-ledger__quick-list">
            {quickLinks.map(({ title, href, icon: Icon }) => (
              <Link
                key={title}
                href={href}
                className="warm-ledger__quick-link"
                aria-label={title}
                title={title}
                aria-current={isCurrentRoute(pathname, href) ? 'page' : undefined}
                onClick={closeAfterNavigation}
              >
                <span className="warm-ledger__quick-icon-wrap" aria-hidden="true">
                  <Icon />
                </span>
                <span>{title}</span>
              </Link>
            ))}
          </div>
        </div>
      </nav>
    </aside>
  )
}
