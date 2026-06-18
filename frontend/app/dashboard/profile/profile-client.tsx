'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { KeyRound, UserCog, FolderKanban } from 'lucide-react'

import { ProfileAvatarTab } from './components/profile-avatar-tab'
import { ProfileInfoTab } from './components/profile-info-tab'
import { ProfileProjectsTab } from './components/profile-projects-tab'

type ProfileTab = 'info' | 'avatar' | 'projects'

const TAB_VALUES: ProfileTab[] = ['info', 'avatar', 'projects']

function isProfileTab(value: string | null): value is ProfileTab {
  return TAB_VALUES.includes(value as ProfileTab)
}

export default function ProfileClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data: session, update } = useSession()

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
    [router, searchParams],
  )

  const userId = session?.user?.id ?? null

  const onAvatarUpdated = React.useCallback(
    async (newUrl: string | null) => {
      // next-auth exposes ``update`` so we can re-trigger the JWT callback
      // and refresh ``session.user.image`` for the sidebar.
      await update({ user: { image: newUrl ?? undefined } })
    },
    [update],
  )

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
      <Card className="dashboard-surface border-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.9),rgba(241,244,247,0.96))] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))]">
        <CardHeader className="space-y-3">
          <p className="dashboard-kicker">个人中心</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <UserCog className="h-5 w-5" />
                我的资料
              </CardTitle>
              <CardDescription>
                管理个人基本信息、头像以及你所参与的项目。
              </CardDescription>
            </div>
            {session?.user?.roleType ? (
              <Badge variant="outline" className="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                {session.user.roleType}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={onTabChange} className="w-full">
            <TabsList className="mb-6 flex w-full flex-wrap sm:w-auto">
              <TabsTrigger value="info" className="flex-1 sm:flex-none">
                <UserCog className="mr-1.5 h-4 w-4" />
                资料设置
              </TabsTrigger>
              <TabsTrigger value="avatar" className="flex-1 sm:flex-none">
                头像
              </TabsTrigger>
              <TabsTrigger value="projects" className="flex-1 sm:flex-none">
                <FolderKanban className="mr-1.5 h-4 w-4" />
                我的项目
              </TabsTrigger>
            </TabsList>

            <TabsContent value="info">
              <ProfileInfoTab />
            </TabsContent>
            <TabsContent value="avatar">
              <ProfileAvatarTab userId={userId} onAvatarUpdated={onAvatarUpdated} />
            </TabsContent>
            <TabsContent value="projects">
              <ProfileProjectsTab />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        <KeyRound className="mr-1 inline h-3 w-3" />
        想修改密码？前往{' '}
        <a href="/dashboard/change-password" className="text-primary underline-offset-2 hover:underline">
          修改密码
        </a>
        。
      </p>
    </div>
  )
}