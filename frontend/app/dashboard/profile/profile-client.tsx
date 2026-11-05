'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, FolderKanban, Image as ImageIcon, UserCog } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { useProfile } from '@/lib/hooks/use-profile'

import { ProfileAvatarTab } from './components/profile-avatar-tab'
import { getRoleLabel } from './components/profile-shared'
import { ProfileInfoTab } from './components/profile-info-tab'
import { ProfileProjectsTab } from './components/profile-projects-tab'
import styles from './profile-warm.module.css'

type ProfileTab = 'info' | 'avatar' | 'projects'

const TAB_VALUES: ProfileTab[] = ['info', 'avatar', 'projects']

function isProfileTab(value: string | null): value is ProfileTab {
  return TAB_VALUES.includes(value as ProfileTab)
}

export default function ProfileClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { profile, loading, error, refetch, update } = useProfile()

  const requestedTab = searchParams.get('tab')
  const initialTab: ProfileTab = isProfileTab(requestedTab) ? requestedTab : 'info'
  const [tab, setTab] = React.useState<ProfileTab>(initialTab)
  const tabRefs = React.useRef<Record<ProfileTab, HTMLButtonElement | null>>({
    info: null,
    avatar: null,
    projects: null,
  })

  React.useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  const onTabChange = React.useCallback(
    (next: string) => {
      if (!isProfileTab(next)) return
      setTab(next)
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'info') {
        params.delete('tab')
      } else {
        params.set('tab', next)
      }
      const qs = params.toString()
      router.replace(qs ? `/dashboard/profile?${qs}` : '/dashboard/profile', { scroll: false })
    },
    [router, searchParams]
  )

  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TAB_VALUES.indexOf(tab)
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % TAB_VALUES.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + TAB_VALUES.length) % TAB_VALUES.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = TAB_VALUES.length - 1
    }

    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = TAB_VALUES[nextIndex]
    onTabChange(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  return (
    <div className={styles.page} data-warm-page="profile">
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>我的资料</h1>
        <div className={styles.headerMeta}>
          {profile?.role_type ? (
            <WarmBadge tone="accent">{getRoleLabel(profile.role_type)}</WarmBadge>
          ) : null}
        </div>
      </header>

      <section className={styles.panel} aria-label="个人资料">
        <div
          role="tablist"
          aria-label="资料分类"
          aria-orientation="horizontal"
          className={styles.tabList}
          onKeyDown={onTabListKeyDown}
        >
          <button
            ref={(node) => {
              tabRefs.current.info = node
            }}
            type="button"
            role="tab"
            id="profile-tab-info"
            aria-selected={tab === 'info'}
            aria-controls="profile-tabpanel"
            tabIndex={tab === 'info' ? 0 : -1}
            onClick={() => onTabChange('info')}
          >
            <UserCog aria-hidden="true" />
            资料设置
          </button>
          <button
            ref={(node) => {
              tabRefs.current.avatar = node
            }}
            type="button"
            role="tab"
            id="profile-tab-avatar"
            aria-selected={tab === 'avatar'}
            aria-controls="profile-tabpanel"
            tabIndex={tab === 'avatar' ? 0 : -1}
            onClick={() => onTabChange('avatar')}
          >
            <ImageIcon aria-hidden="true" />
            头像
          </button>
          <button
            ref={(node) => {
              tabRefs.current.projects = node
            }}
            type="button"
            role="tab"
            id="profile-tab-projects"
            aria-selected={tab === 'projects'}
            aria-controls="profile-tabpanel"
            tabIndex={tab === 'projects' ? 0 : -1}
            onClick={() => onTabChange('projects')}
          >
            <FolderKanban aria-hidden="true" />
            我的项目
          </button>
        </div>

        <div
          className={styles.content}
          id="profile-tabpanel"
          role="tabpanel"
          aria-labelledby={`profile-tab-${tab}`}
        >
          {tab === 'info' ? (
            <ProfileInfoTab
              profile={profile}
              loading={loading}
              error={error}
              onUpdate={update}
            />
          ) : null}
          {tab === 'avatar' ? (
            <ProfileAvatarTab profile={profile} loading={loading} onRefetch={refetch} />
          ) : null}
          {tab === 'projects' ? (
            <ProfileProjectsTab operatorNameCandidates={{ fullName: profile?.full_name ?? null }} />
          ) : null}
        </div>
      </section>

      <div className={styles.footer}>
        <span>想修改密码？前往 </span>
        <Link href="/dashboard/change-password" className={styles.footerLink}>
          修改密码
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}
