'use client'

import Link from 'next/link'
import { Bell, ChevronRight, Menu, RefreshCw, Search, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { WarmIconButton, WarmSelect, type WarmSelectOption } from '../controls'
import { useWarmLedgerNavigation } from './warm-ledger-navigation'

export type WarmLedgerBreadcrumb = {
  label: string
  href?: string
}

export type WarmLedgerRouteSlots = {
  action?: ReactNode
  primary?: ReactNode
  secondary?: ReactNode
}

type RefreshFeedbackStatus = 'idle' | 'loading' | 'requested' | 'success' | 'error'

export type WarmLedgerTopbarProps = {
  routeFrame?: boolean
  breadcrumbs?: ReadonlyArray<WarmLedgerBreadcrumb>
  routeSlots?: WarmLedgerRouteSlots
  showScopeMeta?: boolean
  projectId?: string
  projectOptions?: ReadonlyArray<WarmSelectOption>
  onProjectChange?: (value: string) => void
  projectFilterError?: string | null
  dateRangeLabel?: string
  siteLabel?: string
  onRefresh?: () => void
  refreshing?: boolean
  refreshFeedbackMessage?: string
  refreshFeedbackStatus?: RefreshFeedbackStatus
  onSearch?: () => void
  onNotifications?: () => void
  unreadCount?: number
  onUserAction?: () => void
  profileHref?: string
  userLabel?: string
}

const DEFAULT_BREADCRUMBS: ReadonlyArray<WarmLedgerBreadcrumb> = [
  { label: '运营', href: '/dashboard' },
  { label: '运营总览' },
]

export function WarmLedgerTopbar({
  routeFrame = false,
  breadcrumbs = DEFAULT_BREADCRUMBS,
  routeSlots,
  showScopeMeta = true,
  projectId,
  projectOptions,
  onProjectChange,
  projectFilterError,
  dateRangeLabel = '近 7 天',
  siteLabel,
  onRefresh,
  refreshing = false,
  refreshFeedbackMessage,
  refreshFeedbackStatus = 'idle',
  onSearch,
  onNotifications,
  unreadCount = 0,
  onUserAction,
  profileHref,
  userLabel = '用户菜单',
}: WarmLedgerTopbarProps) {
  const { isMobile, isDrawerOpen, menuButtonRef, openNavigation } = useWarmLedgerNavigation()
  const notificationLabel = unreadCount > 0 ? `通知，${unreadCount} 条未读` : '通知'
  const hasRouteSlots = Boolean(routeSlots?.action || routeSlots?.primary || routeSlots?.secondary)
  const hasHomeActions = Boolean(onRefresh || onSearch || onNotifications)
  const refreshIconClass = [
    'warm-ledger__refresh-icon',
    !refreshing && refreshFeedbackStatus === 'success' && 'is-success',
    !refreshing && refreshFeedbackStatus === 'error' && 'is-error',
    !refreshing && refreshFeedbackStatus === 'requested' && 'is-requested',
  ].filter(Boolean).join(' ')

  return (
    <header
      className={
        routeFrame
          ? 'warm-ledger__topbar warm-ledger__topbar--route'
          : 'warm-ledger__topbar warm-ledger__topbar--home'
      }
    >
      <WarmIconButton
        ref={menuButtonRef}
        className="warm-ledger__mobile-menu"
        aria-label="打开导航"
        aria-controls="dashboard-sidebar"
        aria-expanded={isMobile && isDrawerOpen}
        onClick={() => openNavigation()}
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
        {!routeFrame && projectId !== undefined && projectOptions?.length && onProjectChange ? (
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

        {!routeFrame && showScopeMeta ? (
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
        ) : null}

        {!routeFrame && (dateRangeLabel || siteLabel) ? (
          <div
            className="warm-ledger__mobile-scope"
            aria-label={
              siteLabel
                ? `数据区间：${dateRangeLabel}，PT 运营日，站点：${siteLabel}`
                : `数据区间：${dateRangeLabel}，PT 运营日`
            }
          >
            <span>{dateRangeLabel}</span>
            <span>{siteLabel ? `${siteLabel} · PT 运营日` : 'PT 运营日'}</span>
          </div>
        ) : null}

        {hasHomeActions ? (
          <div
            className="warm-ledger__topbar-action-group"
            role="group"
            aria-label={routeFrame ? '页面快捷操作' : '首页快捷操作'}
          >
            {onRefresh ? (
              <WarmIconButton
                className="warm-ledger__topbar-action"
                aria-label={refreshing ? '正在刷新当前页数据' : '刷新当前页数据'}
                title={refreshFeedbackMessage || '刷新'}
                loading={refreshing}
                loadingLabel="正在刷新当前页数据"
                onClick={onRefresh}
              >
                {refreshing ? null : (
                  <RefreshCw aria-hidden="true" className={refreshIconClass} />
                )}
                <span className="warm-ledger__topbar-action-label" aria-hidden="true">
                  {refreshing ? '刷新中' : '刷新'}
                </span>
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
                <span className="warm-ledger__topbar-action-label" aria-hidden="true">
                  搜索
                </span>
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
                <span className="warm-ledger__topbar-action-label" aria-hidden="true">
                  通知
                </span>
              </WarmIconButton>
            ) : null}
          </div>
        ) : null}
        {profileHref ? (
          <RouteLoadingLink
            href={profileHref}
            className="warm-ledger__icon-button warm-ledger__topbar-action warm-ledger__topbar-action--secondary warm-ledger__profile-action"
            aria-label={userLabel}
            title={userLabel}
          >
            <UserRound aria-hidden="true" />
          </RouteLoadingLink>
        ) : onUserAction ? (
          <WarmIconButton
            className="warm-ledger__topbar-action warm-ledger__topbar-action--secondary warm-ledger__profile-action"
            aria-label={userLabel}
            title={userLabel}
            onClick={onUserAction}
          >
            <UserRound aria-hidden="true" />
          </WarmIconButton>
        ) : null}
      </div>
      {routeFrame && hasRouteSlots ? (
        <div className="warm-ledger__route-slot-row">
          {routeSlots?.action}
          {routeSlots?.primary}
          {routeSlots?.secondary}
        </div>
      ) : null}
      {routeFrame && refreshFeedbackMessage !== undefined ? (
        <span className="warm-ledger__visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {refreshFeedbackMessage}
        </span>
      ) : null}
    </header>
  )
}
