'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, ChevronRight, FolderKanban, Image as ImageIcon, UserCog } from 'lucide-react'

import { TermPanel } from '@/components/terminal/term-panel'
import { TermPill } from '@/components/terminal/term-controls'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { useProfile } from '@/lib/hooks/use-profile'

import { ProfileAvatarTab } from './components/profile-avatar-tab'
import { getRoleLabel } from './components/profile-shared'
import { ProfileInfoTab } from './components/profile-info-tab'
import { ProfileProjectsTab } from './components/profile-projects-tab'

type ProfileTab = 'info' | 'avatar' | 'projects'

const TAB_VALUES: ProfileTab[] = ['info', 'avatar', 'projects']
const TAB_ORDER: ProfileTab[] = TAB_VALUES

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

  // Keep the URL in sync so deep links survive a refresh.
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

  return (
    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <TermPanel
        title="我的资料"
        bodyClassName="p-4"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <TermPill tone="info">个人中心</TermPill>
          <span className="font-mono text-xs text-term-muted">管理个人基本信息、头像以及你所参与的项目。</span>
          {profile?.role_type ? <TermPill tone="accent">{getRoleLabel(profile.role_type)}</TermPill> : null}
        </div>
          <Tabs value={tab} onValueChange={onTabChange} className="w-full">
            {/* BLF-883 全局统一：variant="term" + 前置 icon；w-fit 基座贴合内容，避免 justify-center 全宽留左右空白 */}
            <TabsList variant="term" className="sticky top-0 z-10 w-fit max-w-full justify-start">
              <TabsMotionGroup id="profile-tabs">
                <SlidingTabsTrigger value="info" activeValue={tab} layoutId="profile-tabs" variant="term">
                  <UserCog aria-hidden />
                  资料设置
                </SlidingTabsTrigger>
                <SlidingTabsTrigger value="avatar" activeValue={tab} layoutId="profile-tabs" variant="term">
                  <ImageIcon aria-hidden />
                  头像
                </SlidingTabsTrigger>
                <SlidingTabsTrigger value="projects" activeValue={tab} layoutId="profile-tabs" variant="term">
                  <FolderKanban aria-hidden />
                  我的项目
                </SlidingTabsTrigger>
              </TabsMotionGroup>
            </TabsList>

            <DirectionalTabTransition value={tab} order={TAB_ORDER} className="mt-6">
              <TabsContent value="info" hidden={tab !== 'info'}>
                <ProfileInfoTab
                  profile={profile}
                  loading={loading}
                  error={error}
                  onUpdate={update}
                />
              </TabsContent>
              <TabsContent value="avatar" hidden={tab !== 'avatar'}>
                <ProfileAvatarTab profile={profile} loading={loading} onRefetch={refetch} />
              </TabsContent>
              <TabsContent value="projects" hidden={tab !== 'projects'}>
                <ProfileProjectsTab
                  operatorNameCandidates={{ fullName: profile?.full_name ?? null }}
                />
              </TabsContent>
            </DirectionalTabTransition>
          </Tabs>
      </TermPanel>

      <p className="text-center font-mono text-xs text-term-muted">
        想修改密码？前往{' '}
        <a
          href="/dashboard/change-password"
          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline transition-colors"
        >
          修改密码
          <ArrowRight className="h-3 w-3" />
        </a>
        。
      </p>
    </div>
  )
}
