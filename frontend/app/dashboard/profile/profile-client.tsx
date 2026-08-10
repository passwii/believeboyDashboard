'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, ChevronRight, FolderKanban, UserCog } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { DataCard, DataCardContent, DataCardHeader } from '@/components/ui/data-card'
import { PageHeader } from '@/components/ui/page-header'
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
    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-col gap-1 px-1">
        <nav
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          aria-label="面包屑"
        >
          <a href="/dashboard" className="shrink-0 hover:text-foreground transition-colors">
            管理
          </a>
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="truncate">个人中心</span>
        </nav>
        <PageHeader
          title="我的资料"
          description="管理你的个人信息、头像以及参与的项目。"
        />
      </div>

      <DataCard>
        <DataCardHeader
          badge={
            <Badge
              variant="outline"
              className="w-fit rounded-full border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90"
            >
              个人中心
            </Badge>
          }
          title="我的资料"
          description="管理个人基本信息、头像以及你所参与的项目。"
          action={
            profile?.role_type ? (
              <Badge
                variant="outline"
                className="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
              >
                {getRoleLabel(profile.role_type)}
              </Badge>
            ) : null
          }
        />
        <DataCardContent>
          <Tabs value={tab} onValueChange={onTabChange} className="w-full">
            <TabsList className="sticky top-0 z-10 w-full justify-center rounded-2xl border border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]/95">
              <TabsMotionGroup id="profile-tabs">
                <SlidingTabsTrigger value="info" activeValue={tab} layoutId="profile-tabs">
                  <UserCog className="h-4 w-4" />
                  资料设置
                </SlidingTabsTrigger>
                <SlidingTabsTrigger value="avatar" activeValue={tab} layoutId="profile-tabs">
                  头像
                </SlidingTabsTrigger>
                <SlidingTabsTrigger value="projects" activeValue={tab} layoutId="profile-tabs">
                  <FolderKanban className="h-4 w-4" />
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
                  operatorNameCandidates={{
                    name: profile?.name ?? null,
                    operatorNameZh: profile?.operator_name_zh ?? null,
                  }}
                />
              </TabsContent>
            </DirectionalTabTransition>
          </Tabs>
        </DataCardContent>
      </DataCard>

      <p className="text-center text-xs text-muted-foreground">
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
