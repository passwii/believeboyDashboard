'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Search, X, type LucideIcon } from 'lucide-react'
import {
  SIDEBAR_TOP_GROUPS,
  filterByRole,
  type SidebarSubItem,
} from '@/lib/sidebar-config'
import { getDashboardRouteMeta } from '@/lib/dashboard-route-meta'
import { WarmIconButton } from '../controls'
import {
  useWarmLedgerNavigation,
  type MobileNavigationDomain,
} from './warm-ledger-navigation'

/**
 * 侧栏两级导航的唯一数据源仍是 lib/sidebar-config.ts。
 *
 * 外层 = 9 个业务域分组；分组头是可折叠按钮，组内列出该分组的全部条目。
 * 这样每个已配置页面都有侧栏入口，不再依赖逐个挑选的精选簇。
 * 展开状态写 localStorage；当前页所在分组始终自动展开。
 */
export const WARM_SIDEBAR_STORAGE_KEY = 'warm-ledger-sidebar-expanded-groups'

const QUICK_LINK_TITLES = ['销售数据', '订单信息', '库存分析', '客户消息'] as const
const OVERVIEW_ROUTE = '/dashboard'
const DEFAULT_EXPANDED_GROUP_ID = 'operations'
const OVERVIEW_ICON = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'operations')?.icon
const MOBILE_DOMAIN_LABELS: Record<MobileNavigationDomain, string> = {
  operations: '运营',
  reports: '报表',
  ai: 'AI',
  all: '全部',
}

type WarmNavigationItem = {
  title: string
  href: string
  icon: LucideIcon
}

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

function getRouteHref(pathname: string) {
  return getDashboardRouteMeta(pathname)?.navHref ?? pathname
}

function groupOwnsHref(groupItems: SidebarSubItem[], href: string) {
  return groupItems.some(
    (item) =>
      item.url === href ||
      (item.matchPrefixes ?? []).some((prefix) => href.startsWith(prefix))
  )
}

function getOwningGroupId(pathname: string) {
  const href = getRouteHref(pathname)
  for (const group of SIDEBAR_TOP_GROUPS) {
    if (groupOwnsHref(filterByRole(group.items), href)) return group.id
  }
  return undefined
}

function isCurrentRoute(pathname: string, href: string) {
  return getRouteHref(pathname) === href
}

function matchesQuery(value: string, query: string) {
  return value.toLocaleLowerCase().includes(query)
}

function readStoredGroupIds(): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(WARM_SIDEBAR_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return null
  }
}

const quickLinks = QUICK_LINK_TITLES.flatMap((title) => {
  for (const group of SIDEBAR_TOP_GROUPS) {
    const item = filterByRole(group.items).find((entry) => entry.title === title)
    if (item) return [toNavigationItem(item, group.icon)]
  }
  return []
})

export function WarmLedgerSidebar() {
  const pathname = usePathname() ?? ''
  const {
    isMobile,
    isPhone,
    isDrawerOpen,
    mobileDomain,
    sidebarRef,
    closeNavigation,
  } = useWarmLedgerNavigation()
  const currentGroupId = getOwningGroupId(pathname)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set([currentGroupId ?? DEFAULT_EXPANDED_GROUP_ID])
  )
  const [restored, setRestored] = useState(false)
  const navScrollRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const drawerGroups = useMemo(
    () =>
      SIDEBAR_TOP_GROUPS.filter(
        (group) =>
          !isPhone || mobileDomain === 'all' || group.id === mobileDomain
      ),
    [isPhone, mobileDomain]
  )
  const groupViews = useMemo(
    () =>
      drawerGroups
        .map((group) => {
          const labelMatches = Boolean(
            normalizedQuery && matchesQuery(group.label, normalizedQuery)
          )
          const excludeQuickLinks =
            isPhone && mobileDomain === 'operations' && group.id === 'operations'
          const routeItems = filterByRole(group.items).filter(
            (item) =>
              !excludeQuickLinks ||
              !QUICK_LINK_TITLES.includes(
                item.title as (typeof QUICK_LINK_TITLES)[number]
              )
          )
          const items =
            normalizedQuery && !labelMatches
              ? routeItems.filter((item) =>
                  matchesQuery(item.title, normalizedQuery)
                )
              : routeItems

          return {
            group,
            items,
            labelMatches,
            searchGroupId:
              normalizedQuery && (labelMatches || items.length > 0)
                ? group.id
                : null,
          }
        })
        .filter(
          (view) =>
            !normalizedQuery || view.labelMatches || view.items.length > 0
        ),
    [drawerGroups, isPhone, mobileDomain, normalizedQuery]
  )
  const mobileQuickLinks =
    isPhone && mobileDomain === 'operations'
      ? quickLinks.filter(
          ({ title }) =>
            !normalizedQuery || matchesQuery(title, normalizedQuery)
        )
      : []
  const drawerHasResults =
    mobileQuickLinks.length > 0 ||
    groupViews.some((view) => view.labelMatches || view.items.length > 0)

  const closeAfterNavigation = useCallback(() => {
    if (isMobile && isDrawerOpen) closeNavigation()
  }, [closeNavigation, isDrawerOpen, isMobile])

  // 恢复上次展开状态。首帧统一用默认值，避免服务端预渲染与客户端不一致。
  useEffect(() => {
    const stored = readStoredGroupIds()
    setRestored(true)
    if (!stored || stored.length === 0) return
    setExpandedGroupIds((previous) => new Set([...previous, ...stored]))
  }, [])

  // 当前页所在分组始终展开：首次进入与路由切换都保证入口可见。
  useEffect(() => {
    if (!currentGroupId) return
    setExpandedGroupIds((previous) =>
      previous.has(currentGroupId)
        ? previous
        : new Set([...previous, currentGroupId])
    )
  }, [currentGroupId])

  useEffect(() => {
    setSearchQuery('')
  }, [isDrawerOpen, mobileDomain])

  useEffect(() => {
    if (!isPhone || !isDrawerOpen || mobileDomain === 'all') return
    setExpandedGroupIds((previous) =>
      previous.has(mobileDomain)
        ? previous
        : new Set([...previous, mobileDomain])
    )
  }, [isDrawerOpen, isPhone, mobileDomain])

  useEffect(() => {
    if (!normalizedQuery) return
    const matchingGroupIds = groupViews
      .map((view) => view.searchGroupId)
      .filter((id): id is string => Boolean(id))
    if (matchingGroupIds.length === 0) return
    setExpandedGroupIds((previous) => {
      const next = new Set(previous)
      matchingGroupIds.forEach((id) => next.add(id))
      return next
    })
  }, [groupViews, normalizedQuery])

  // 深链直接打开页面时把当前条目滚进可视区；只在路由变化时触发，不打断手动展开。
  useEffect(() => {
    const scroller = navScrollRef.current
    if (!scroller) return
    const current = scroller.querySelector<HTMLElement>('[aria-current="page"]')
    current?.scrollIntoView?.({ block: 'nearest' })
  }, [pathname])

  useEffect(() => {
    if (!restored) return
    try {
      window.localStorage.setItem(
        WARM_SIDEBAR_STORAGE_KEY,
        JSON.stringify([...expandedGroupIds])
      )
    } catch {
      // 隐私模式下写入失败不影响导航。
    }
  }, [expandedGroupIds, restored])

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroupIds((previous) => {
      const next = new Set(previous)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  return (
    <aside
      ref={sidebarRef}
      id="dashboard-sidebar"
      className="warm-ledger__sidebar"
      aria-label={
        isPhone
          ? `${MOBILE_DOMAIN_LABELS[mobileDomain]}导航抽屉`
          : '主导航'
      }
      aria-hidden={isMobile && !isDrawerOpen ? true : undefined}
    >
      {isPhone ? (
        <span className="warm-ledger__drawer-grip" aria-hidden="true" />
      ) : null}
      <label className="warm-ledger__mobile-search" hidden={!isPhone}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索页面"
          placeholder="搜索页面"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          data-warm-ledger-search
        />
      </label>
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
        <div ref={navScrollRef} className="warm-ledger__navigation-scroll">
          {mobileQuickLinks.length > 0 ? (
            <div className="warm-ledger__mobile-quick-section">
              <span className="warm-ledger__nav-label">快捷入口</span>
              <div className="warm-ledger__quick-list warm-ledger__mobile-quick-links">
                {mobileQuickLinks.map(({ title, href, icon: Icon }) => (
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
          ) : null}

          <span className="warm-ledger__nav-label">
            {isPhone && mobileDomain !== 'all' ? '页面' : '业务域'}
          </span>
          <div className="warm-ledger__nav-list">
            {!isPhone ? (
              <Link
                href={OVERVIEW_ROUTE}
                className="warm-ledger__nav-item"
                aria-label="运营总览"
                title="运营总览"
                aria-current={pathname === OVERVIEW_ROUTE ? 'page' : undefined}
                onClick={closeAfterNavigation}
              >
                <span className="warm-ledger__nav-indicator" aria-hidden="true" />
                <span className="warm-ledger__nav-icon-wrap">
                  {OVERVIEW_ICON ? <OVERVIEW_ICON aria-hidden="true" /> : null}
                </span>
                <span className="warm-ledger__nav-copy">运营总览</span>
              </Link>
            ) : null}

            {groupViews.map(({ group, items: groupItems, labelMatches }) => {
              if (groupItems.length === 0 && !labelMatches) return null
              const expanded = expandedGroupIds.has(group.id)
              const panelId = `warm-ledger-nav-${group.id}`
              const GroupIcon = group.icon

              return (
                <div key={group.id} className="warm-ledger__nav-group">
                  <button
                    type="button"
                    className="warm-ledger__nav-group-toggle"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    data-current={currentGroupId === group.id ? 'true' : undefined}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span className="warm-ledger__nav-indicator" aria-hidden="true" />
                    <span className="warm-ledger__nav-icon-wrap" aria-hidden="true">
                      <GroupIcon />
                    </span>
                    <span className="warm-ledger__nav-copy">{group.label}</span>
                    <span className="warm-ledger__nav-chevron" aria-hidden="true">
                      <ChevronRight />
                    </span>
                  </button>
                  <div
                    id={panelId}
                    className="warm-ledger__nav-list warm-ledger__nav-group-panel"
                    hidden={!expanded}
                  >
                    {groupItems.map((item) => {
                      const { title, href, icon: Icon } = toNavigationItem(
                        item,
                        group.icon
                      )
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
              )
            })}
          </div>
          {isPhone && normalizedQuery && !drawerHasResults ? (
            <p className="warm-ledger__mobile-search-empty" role="status">
              没有匹配的页面
            </p>
          ) : null}
        </div>

        {!isPhone ? (
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
        ) : null}
      </nav>
    </aside>
  )
}
