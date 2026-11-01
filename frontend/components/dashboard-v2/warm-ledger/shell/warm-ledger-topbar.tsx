'use client'

import Link from 'next/link'
import { Bell, ChevronRight, Menu, RefreshCw, Search, UserRound } from 'lucide-react'
import { WarmIconButton, WarmSelect, type WarmSelectOption } from '../controls'
import { useWarmLedgerNavigation } from './warm-ledger-navigation'

export type WarmLedgerBreadcrumb = {
  label: string
  href?: string
}

export type WarmLedgerTopbarProps = {
  breadcrumbs?: ReadonlyArray<WarmLedgerBreadcrumb>
  projectId?: string
  projectOptions?: ReadonlyArray<WarmSelectOption>
  onProjectChange?: (value: string) => void
  projectFilterError?: string | null
  dateRangeLabel?: string
  siteLabel?: string
  onRefresh?: () => void
  refreshing?: boolean
  onSearch?: () => void
  onNotifications?: () => void
  unreadCount?: number
  onUserAction?: () => void
  userLabel?: string
}

const DEFAULT_BREADCRUMBS: ReadonlyArray<WarmLedgerBreadcrumb> = [
  { label: '运营', href: '/dashboard' },
  { label: '运营总览' },
]

export function WarmLedgerTopbar({
  breadcrumbs = DEFAULT_BREADCRUMBS,
  projectId,
  projectOptions,
  onProjectChange,
  projectFilterError,
  dateRangeLabel = '近 7 天',
  siteLabel,
  onRefresh,
  refreshing = false,
  onSearch,
  onNotifications,
  unreadCount = 0,
  onUserAction,
  userLabel = '用户菜单',
}: WarmLedgerTopbarProps) {
  const { isMobile, isDrawerOpen, menuButtonRef, openNavigation } = useWarmLedgerNavigation()
  const notificationLabel = unreadCount > 0 ? `通知，${unreadCount} 条未读` : '通知'

  return (
    <header className="warm-ledger__topbar">
      <WarmIconButton
        ref={menuButtonRef}
        className="warm-ledger__mobile-menu"
        aria-label="打开导航"
        aria-controls="dashboard-sidebar"
        aria-expanded={isMobile && isDrawerOpen}
        onClick={openNavigation}
      >
        <Menu aria-hidden="true" />
      </WarmIconButton>

      <nav className="warm-ledger__breadcrumb" aria-label="面包屑">
        {breadcrumbs.map((crumb, index) => {
          const current = index === breadcrumbs.length - 1
          return (
            <span className="warm-ledger__breadcrumb-part" key={`${crumb.label}-${index}`}>
              {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
              {current ? (
                <span aria-current="page">{crumb.label}</span>
              ) : crumb.href ? (
                <Link href={crumb.href}>{crumb.label}</Link>
              ) : (
                <span>{crumb.label}</span>
              )}
            </span>
          )
        })}
      </nav>

      <div className="warm-ledger__topbar-controls">
        {projectId !== undefined && projectOptions?.length && onProjectChange ? (
          <WarmSelect
            id="warm-ledger-project-filter"
            label="项目筛选"
            value={projectId}
            options={projectOptions}
            onChange={onProjectChange}
            disabled={Boolean(projectFilterError)}
            error={projectFilterError}
            className="warm-ledger__project-select"
          />
        ) : null}

        <div
          className="warm-ledger__scope-meta"
          aria-label={
            siteLabel
              ? `数据区间：${dateRangeLabel}，PT 运营日，站点：${siteLabel}`
              : `数据区间：${dateRangeLabel}，PT 运营日`
          }
          title="按 PT 运营日计算"
        >
          <span className="warm-ledger__scope-item">
            <span>数据区间</span>
            <span className="warm-ledger__scope-value">{dateRangeLabel}</span>
            <span className="warm-ledger__scope-zone">PT 运营日</span>
          </span>
          {siteLabel ? (
            <span className="warm-ledger__scope-item">
              <span>站点</span>
              <span className="warm-ledger__scope-value">{siteLabel}</span>
            </span>
          ) : null}
        </div>

        {onRefresh ? (
          <WarmIconButton
            className="warm-ledger__topbar-action"
            aria-label={refreshing ? '正在刷新当前页数据' : '刷新当前页数据'}
            title="刷新"
            loading={refreshing}
            loadingLabel="正在刷新当前页数据"
            onClick={onRefresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={refreshing ? 'warm-ledger__refresh-icon is-refreshing' : 'warm-ledger__refresh-icon'}
            />
          </WarmIconButton>
        ) : null}
        {onSearch ? (
          <WarmIconButton
            className="warm-ledger__topbar-action warm-ledger__topbar-action--secondary"
            aria-label="全局搜索"
            title="搜索"
            onClick={onSearch}
          >
            <Search aria-hidden="true" />
          </WarmIconButton>
        ) : null}
        {onNotifications ? (
          <WarmIconButton
            className="warm-ledger__topbar-action warm-ledger__notification-action"
            aria-label={notificationLabel}
            title="通知"
            onClick={onNotifications}
          >
            <Bell aria-hidden="true" />
            {unreadCount > 0 ? (
              <span className="warm-ledger__notification-dot" aria-hidden="true" />
            ) : null}
          </WarmIconButton>
        ) : null}
        {onUserAction ? (
          <WarmIconButton
            className="warm-ledger__topbar-action warm-ledger__topbar-action--secondary"
            aria-label={userLabel}
            title={userLabel}
            onClick={onUserAction}
          >
            <UserRound aria-hidden="true" />
          </WarmIconButton>
        ) : null}
      </div>
    </header>
  )
}
