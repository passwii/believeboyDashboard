# User Info 页面重构 实现计划（BEL-143）

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。设计文档见 `docs/superpowers/specs/2026-06-20-profile-page-refactor-design.md`。

**目标：** 把 `/dashboard/profile` 从 a20fcc4 落地的"能跑"版本升级为与 `operator-management` / `account-management` 设计系统对齐的"齐整"版本：UI 用 `DataCard` + `SlidingTabsTrigger` + `Table`，3 个 240+ 行的大文件按 form/display/hook 三层拆开，引入共享 `useProfile()` 消除 2 次重复 fetch，加 per-tab skeleton + 移动端卡片列表。

**架构：** 新增 `frontend/lib/hooks/use-profile.ts` + `frontend/lib/client-api/profile-client.ts` + `frontend/types/profile.ts` 三件套作为新数据层；`profile-client.tsx` 顶层订阅一次，3 个 tab 通过 props 拿 `profile`/`refetch`/`update`。组件按职责拆 7 个小文件。

**技术栈：** Next.js 14 (App Router), React 18, Tailwind CSS, shadcn/ui (`Card`/`Tabs`/`Table`), framer-motion (`DirectionalTabTransition`/`SlidingTabsTrigger`), `useSession()` from `next-auth@5.0.0-beta.31`, 既有 `client-cache.ts` 不引入新依赖。

---

## 文件结构

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `frontend/types/profile.ts` | `Profile` / `ProfileUpdate` / `ProfileRoleType` |
| 新建 | `frontend/lib/client-api/profile-client.ts` | fetch 包装：`fetchProfile` / `updateProfile` / `uploadAvatar` / `deleteAvatar` |
| 新建 | `frontend/lib/hooks/use-profile.ts` | `useProfile()` hook（单 fetch 源 + 60s 内存缓存 + update） |
| 修改 | `frontend/app/dashboard/profile/profile-client.tsx` | 用 `DataCard` + `SlidingTabsTrigger`；顶层 `useProfile()` |
| 修改 | `frontend/app/dashboard/profile/loading.tsx` | 改用 `ProfileInfoSkeleton` |
| 修改 | `frontend/app/dashboard/profile/components/profile-info-tab.tsx` | 拆出 stats，只保留 form |
| 新建 | `frontend/app/dashboard/profile/components/profile-info-stats.tsx` | 角色 / 状态 / 改密时间 3 stats |
| 修改 | `frontend/app/dashboard/profile/components/profile-avatar-tab.tsx` | 拆出 display，只保留 actions |
| 新建 | `frontend/app/dashboard/profile/components/profile-avatar-display.tsx` | 头像预览 + 缓存说明 |
| 修改 | `frontend/app/dashboard/profile/components/profile-projects-tab.tsx` | 改 `DataTableCard` + `Table`；接 `useProfile()` + props |
| 新建 | `frontend/app/dashboard/profile/components/profile-projects-card.tsx` | 移动端卡片列表 |
| 新建 | `frontend/app/dashboard/profile/components/profile-shared.ts` | 共享：`ROLE_LABELS`、`ProfileRoleType`、`formatDate` |
| 新建 | `frontend/app/dashboard/profile/components/profile-skeletons.tsx` | 3 个 per-tab skeleton |
| 不变 | `frontend/app/dashboard/profile/page.tsx` | 薄壳 |
| 不变 | `frontend/app/api/user/profile/route.ts` | 转发层 |
| 不变 | `frontend/app/api/user/avatar/route.ts` | 转发层 |
| 不变 | `frontend/app/dashboard/change-password/page.tsx` | 单独入口保留 |
| 不变 | `frontend/lib/user-avatar-cache.ts` | R2 缓存行为保留 |

---

## 任务 1：共享类型 + client-api 包装 + hook

### 文件
- 新建：`frontend/types/profile.ts`
- 新建：`frontend/lib/client-api/profile-client.ts`
- 新建：`frontend/lib/hooks/use-profile.ts`

- [ ] **步骤 1.1：写 `frontend/types/profile.ts`**

按规格 §4.4 落地：

```ts
export type ProfileRoleType = 'admin' | 'operator' | 'businessdev'

export interface Profile {
  id: string
  email: string
  name: string
  full_name: string | null
  operator_name_zh: string | null
  is_admin: boolean
  is_active: boolean
  role_type: ProfileRoleType
  avatar_url: string | null
  password_changed_at: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type ProfileUpdate = {
  name?: string
  full_name?: string | null
  operator_name_zh?: string | null
}
```

- [ ] **步骤 1.2：写 `frontend/lib/client-api/profile-client.ts`**

参照 `frontend/lib/project-client-cache.ts` 的风格（不持久化 sessionStorage，仅内存 + 简单 TTL），导出 4 个函数：

```ts
'use client'

import type { Profile, ProfileUpdate } from '@/types/profile'
import { normalizeErrorMessage } from '@/lib/error-utils'

const PROFILE_CACHE_KEY = 'profile:current'
const PROFILE_CACHE_TTL_MS = 60 * 1000

let cachedProfile: { updatedAt: number; value: Profile } | null = null

function readCache(): Profile | null {
  if (!cachedProfile) return null
  if (Date.now() - cachedProfile.updatedAt > PROFILE_CACHE_TTL_MS) {
    cachedProfile = null
    return null
  }
  return cachedProfile.value
}

function writeCache(value: Profile): void {
  cachedProfile = { updatedAt: Date.now(), value }
}

export function clearProfileClientCache(): void {
  cachedProfile = null
}

export async function fetchProfile(): Promise<Profile> {
  const cached = readCache()
  if (cached) return cached

  const response = await fetch('/api/user/profile', { cache: 'no-store' })
  const body = (await response.json()) as Partial<Profile> & { message?: string }
  if (!response.ok) {
    throw new Error(body.message || '加载失败')
  }
  const profile = body as Profile
  writeCache(profile)
  return profile
}

export async function updateProfile(patch: ProfileUpdate): Promise<Profile> {
  const response = await fetch('/api/user/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = (await response.json()) as Partial<Profile> & { message?: string }
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(body.message, '保存失败'))
  }
  const profile = body as Profile
  writeCache(profile)
  return profile
}

export async function uploadAvatar(file: File): Promise<{ avatar_url: string }> {
  const formData = new FormData()
  formData.append('file', file, file.name)
  const response = await fetch('/api/user/avatar', {
    method: 'POST',
    body: formData,
  })
  const body = (await response.json()) as
    | { avatar_url: string; size: number; content_type: string }
    | { message?: string }
  if (!response.ok || !('avatar_url' in body) || !body.avatar_url) {
    throw new Error('message' in body && body.message ? body.message : '上传失败')
  }
  clearProfileClientCache() // avatar_url 已变，缓存失效
  return { avatar_url: body.avatar_url }
}

export async function deleteAvatar(): Promise<void> {
  const response = await fetch('/api/user/avatar', { method: 'DELETE' })
  const body = (await response.json()) as { ok?: boolean; message?: string }
  if (!response.ok || !body.ok) {
    throw new Error(body.message || '删除失败')
  }
  clearProfileClientCache()
}
```

- [ ] **步骤 1.3：写 `frontend/lib/hooks/use-profile.ts`**

参照 `frontend/lib/hooks/use-managed-projects.ts` 风格：

```ts
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

import type { Profile, ProfileUpdate } from '@/types/profile'
import {
  clearProfileClientCache,
  fetchProfile,
  updateProfile,
} from '@/lib/client-api/profile-client'

export interface UseProfileResult {
  profile: Profile | null
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  update: (patch: ProfileUpdate) => Promise<Profile>
}

export function useProfile(): UseProfileResult {
  const { data: session, status, update: updateSession } = useSession()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState<boolean>(status !== 'authenticated')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (status !== 'authenticated') return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchProfile()
      setProfile(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const refetch = useCallback(async () => {
    clearProfileClientCache()
    await load()
  }, [load])

  const update = useCallback(
    async (patch: ProfileUpdate) => {
      const next = await updateProfile(patch)
      setProfile(next)
      // Keep the JWT-derived session in sync so the sidebar reflects
      // name / avatar changes immediately.
      await updateSession({
        user: {
          name: next.name,
          image: next.avatar_url ?? undefined,
        },
      })
      return next
    },
    [updateSession],
  )

  return { profile, loading, error, refetch, update }
}
```

- [ ] **步骤 1.4：lint + 类型检查**

```bash
cd frontend && pnpm lint 2>&1 | tail -20
```

预期：3 个新文件无 lint 警告。如果 `useSession()` 类型不匹配 `updateSession({ user: { ... } })` 形态，按 next-auth 5 beta 31 实际签名调整（已在 `profile-client.tsx` 原代码里跑过同样调用）。

---

## 任务 2：共享辅助 + 3 个 per-tab skeleton

### 文件
- 新建：`frontend/app/dashboard/profile/components/profile-shared.ts`
- 新建：`frontend/app/dashboard/profile/components/profile-skeletons.tsx`
- 修改：`frontend/app/dashboard/profile/loading.tsx`

- [ ] **步骤 2.1：写 `profile-shared.ts`**

集中角色 label map、`formatDate`、`ProfileRoleType` re-export（避免 3 个 tab 各 import `Profile` 类型时拼写漂移）：

```ts
import type { ProfileRoleType } from '@/types/profile'

export const ROLE_LABELS: Record<ProfileRoleType, string> = {
  admin: '管理员',
  operator: '运营',
  businessdev: '招商',
}

export function getRoleLabel(role: ProfileRoleType): string {
  return ROLE_LABELS[role] ?? role
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export type { ProfileRoleType }
```

- [ ] **步骤 2.2：写 `profile-skeletons.tsx`**

3 个 skeleton（基于 `Skeleton` + `TableSkeletonRows`）：

```tsx
'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'

export function ProfileInfoSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProfileAvatarSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-40 w-40 rounded-2xl" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-3 w-full" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <div className="rounded-lg border border-border/40 bg-card/40 p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-5/6" />
          <Skeleton className="mt-1 h-3 w-4/6" />
        </div>
      </div>
    </div>
  )
}

export function ProfileProjectsSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="bg-muted/50 px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            {Array.from({ length: 7 }).map((_, i) => (
              <th key={i} className="px-4 py-3 text-left">
                <Skeleton className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          <TableSkeletonRows columns={7} rows={5} />
        </tbody>
      </table>
    </div>
  )
}
```

> 注：`profile-skeletons.tsx` 不与 `Table` 组件绑定 —— 等任务 4 把 `profile-projects-tab.tsx` 切到 `Table` 后，可以替换为 `<Table><TableHeader>...<TableBody><TableSkeletonRows columns={7} rows={5} /></TableBody></Table>`。本次先用 plain HTML table 适配 skeleton 阶段，结构等价。

- [ ] **步骤 2.3：改 `loading.tsx`**

```tsx
import { ProfileInfoSkeleton } from './components/profile-skeletons'

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
      <div className="dashboard-surface p-6">
        <ProfileInfoSkeleton />
      </div>
    </div>
  )
}
```

（默认 tab 是 info，对应 `ProfileInfoSkeleton`；用户通过 URL 直接进 avatar/projects 时 skeleton 仍按 info 渲染是 Next.js loading.tsx 的已知约束 —— Suspense 边界触发时还不知道 query，可接受。）

- [ ] **步骤 2.4：lint**

```bash
cd frontend && pnpm lint 2>&1 | tail -20
```

---

## 任务 3：profile-client.tsx 顶层（DataCard + SlidingTabsTrigger + 接 useProfile）

### 文件
- 修改：`frontend/app/dashboard/profile/profile-client.tsx`

- [ ] **步骤 3.1：重写 `profile-client.tsx`**

参照 `frontend/app/dashboard/system-management/operator-management/page.tsx:639-653` 的 Tabs 模式 + `account-management` 的 DataCard 模式：

```tsx
'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FolderKanban, UserCog } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  DataCard,
  DataCardContent,
  DataCardHeader,
} from '@/components/ui/data-card'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'

import { useProfile } from '@/lib/hooks/use-profile'

import { ProfileAvatarTab } from './components/profile-avatar-tab'
import { getRoleLabel } from './components/profile-shared'
import { ProfileInfoTab } from './components/profile-info-tab'
import { ProfileProjectsTab } from './components/profile-projects-tab'

type ProfileTab = 'info' | 'avatar' | 'projects'

const TAB_VALUES: ProfileTab[] = ['info', 'avatar', 'projects']
const TAB_ORDER = TAB_VALUES

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
    [router, searchParams],
  )

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
      <DataCard>
        <DataCardHeader
          badge={
            <Badge
              variant="outline"
              className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
            >
              个人中心
            </Badge>
          }
          title="我的资料"
          description="管理个人基本信息、头像以及你所参与的项目。"
          action={
            profile?.role_type ? (
              <Badge variant="outline" className="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                {getRoleLabel(profile.role_type)}
              </Badge>
            ) : null
          }
        />
        <DataCardContent>
          <Tabs value={tab} onValueChange={onTabChange} className="w-full">
            <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-muted/25 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
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
              <TabsContent value="info" forceMount={tab === 'info' ? true : undefined} hidden={tab !== 'info'}>
                <ProfileInfoTab profile={profile} loading={loading} error={error} onUpdate={update} />
              </TabsContent>
              <TabsContent value="avatar" forceMount={tab === 'avatar' ? true : undefined} hidden={tab !== 'avatar'}>
                <ProfileAvatarTab profile={profile} loading={loading} onRefetch={refetch} />
              </TabsContent>
              <TabsContent value="projects" forceMount={tab === 'projects' ? true : undefined} hidden={tab !== 'projects'}>
                <ProfileProjectsTab profile={profile} />
              </TabsContent>
            </DirectionalTabTransition>
          </Tabs>
        </DataCardContent>
      </DataCard>

      <p className="text-center text-xs text-muted-foreground">
        想修改密码？前往{' '}
        <a href="/dashboard/change-password" className="text-primary underline-offset-2 hover:underline">
          修改密码
        </a>
        。
      </p>
    </div>
  )
}
```

> 注：`DirectionalTabTransition` 当前实现（`tab-motion.tsx`）内部用 `AnimatePresence`，会把 `value` 之外的内容 unmount。若同时需要 form 状态保留，可考虑延迟引入 `forceMount` —— 任务 4 里根据实测决定。如果切 tab 时 form 输入会丢，把 `DirectionalTabTransition` 包裹层去掉即可（保留 `Tabs` 默认行为）。

- [ ] **步骤 3.2：先占位 stub 3 个子组件 + lint**

为让任务 3 能独立 lint/build，先把 3 个子组件改成接收 props 的最小 stub（每个组件先返回 `<div />`，但签名匹配）：

`profile-info-tab.tsx`：
```tsx
'use client'
import type { Profile, ProfileUpdate } from '@/types/profile'
export function ProfileInfoTab(props: {
  profile: Profile | null
  loading: boolean
  error: string | null
  onUpdate: (patch: ProfileUpdate) => Promise<Profile>
}) { void props; return <div /> }
```

`profile-avatar-tab.tsx`：
```tsx
'use client'
import type { Profile } from '@/types/profile'
export function ProfileAvatarTab(props: {
  profile: Profile | null
  loading: boolean
  onRefetch: () => Promise<void>
}) { void props; return <div /> }
```

`profile-projects-tab.tsx`：
```tsx
'use client'
import type { Profile } from '@/types/profile'
export function ProfileProjectsTab(props: { profile: Profile | null }) { void props; return <div /> }
```

```bash
cd frontend && pnpm lint 2>&1 | tail -20
cd frontend && pnpm build 2>&1 | tail -20
```

预期：build 通过；3 个 stub 不报错。

---

## 任务 4：info tab 拆 form + stats

### 文件
- 重写：`frontend/app/dashboard/profile/components/profile-info-tab.tsx`
- 新建：`frontend/app/dashboard/profile/components/profile-info-stats.tsx`

- [ ] **步骤 4.1：写 `profile-info-stats.tsx`**

纯展示组件，3 个 stats cards：

```tsx
'use client'

import * as React from 'react'

import { Badge } from '@/components/ui/badge'

import { formatDate, getRoleLabel } from './profile-shared'
import type { Profile } from '@/types/profile'

export function ProfileInfoStats({ profile }: { profile: Profile }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">角色</p>
        <div className="mt-1.5">
          <Badge variant="outline">{getRoleLabel(profile.role_type)}</Badge>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">账号状态</p>
        <div className="mt-1.5">
          <Badge variant={profile.is_active ? 'default' : 'destructive'}>
            {profile.is_active ? '启用' : '停用'}
          </Badge>
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">上次修改密码</p>
        <p className="mt-1.5 text-sm">{formatDate(profile.password_changed_at)}</p>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4.2：重写 `profile-info-tab.tsx`**

把原 244 行拆到只剩 form（约 130 行），去掉自带 `fetch`，改成从 props 拿数据：

```tsx
'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import type { Profile, ProfileUpdate } from '@/types/profile'

import { ProfileInfoSkeleton } from './profile-skeletons'
import { ProfileInfoStats } from './profile-info-stats'

interface ProfileInfoTabProps {
  profile: Profile | null
  loading: boolean
  error: string | null
  onUpdate: (patch: ProfileUpdate) => Promise<Profile>
}

export function ProfileInfoTab({ profile, loading, error, onUpdate }: ProfileInfoTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [name, setName] = React.useState('')
  const [fullName, setFullName] = React.useState('')
  const [operatorName, setOperatorName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [initialized, setInitialized] = React.useState(false)

  // Local state is the source of truth for the form. Seed it once when the
  // profile arrives, then keep it in sync with subsequent updates.
  React.useEffect(() => {
    if (!profile || initialized) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setOperatorName(profile.operator_name_zh ?? '')
    setInitialized(true)
  }, [profile, initialized])

  // If the profile reference changes after a successful update, refresh
  // local state so the user always sees what the server has.
  React.useEffect(() => {
    if (!profile) return
    setName(profile.name ?? '')
    setFullName(profile.full_name ?? '')
    setOperatorName(profile.operator_name_zh ?? '')
  }, [profile])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      notify({ type: 'error', title: '姓名不能为空' })
      return
    }

    const patch: ProfileUpdate = {}
    if (trimmedName !== profile.name) patch.name = trimmedName
    const trimmedFull = fullName.trim()
    if ((trimmedFull || null) !== (profile.full_name ?? null)) {
      patch.full_name = trimmedFull || null
    }
    const trimmedOperator = operatorName.trim()
    if ((trimmedOperator || null) !== (profile.operator_name_zh ?? null)) {
      patch.operator_name_zh = trimmedOperator || null
    }

    if (Object.keys(patch).length === 0) {
      notify({ type: 'info', title: '没有需要保存的修改' })
      return
    }

    setSubmitting(true)
    try {
      await onUpdate(patch)
      notify({ type: 'success', title: '资料已保存' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '保存失败') })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading && !profile) {
    return <ProfileInfoSkeleton />
  }

  if (error && !profile) {
    return (
      <p className="text-sm text-muted-foreground">无法加载个人资料，请稍后重试。</p>
    )
  }

  if (!profile) {
    return null
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="profile-email">邮箱</Label>
        <Input id="profile-email" type="email" value={profile.email} disabled readOnly />
        <p className="text-xs text-muted-foreground">邮箱用于登录，不可修改。如需更换请联系管理员。</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name">显示名 *</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-full-name">全名</Label>
        <Input
          id="profile-full-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          placeholder="可选"
        />
      </div>

      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="profile-operator-name">运营名（中文）</Label>
        <Input
          id="profile-operator-name"
          value={operatorName}
          onChange={(e) => setOperatorName(e.target.value)}
          disabled={submitting}
          maxLength={255}
          placeholder="用于匹配项目运营 / 助理运营"
        />
        <p className="text-xs text-muted-foreground">
          ⚠ 此字段用于与项目里的运营 / 助理运营名进行匹配。修改后会自动同步到项目管理。
        </p>
      </div>

      <ProfileInfoStats profile={profile} />

      {session?.user?.email ? (
        <p className="text-xs text-muted-foreground md:col-span-2">
          当前登录身份：{session.user.email}
        </p>
      ) : null}

      <div className="flex justify-end md:col-span-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitting ? '保存中...' : '保存修改'}
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **步骤 4.3：lint + build**

```bash
cd frontend && pnpm lint 2>&1 | tail -10
cd frontend && pnpm build 2>&1 | tail -20
```

预期：lint + build 通过。

---

## 任务 5：avatar tab 拆 display + actions

### 文件
- 重写：`frontend/app/dashboard/profile/components/profile-avatar-tab.tsx`
- 新建：`frontend/app/dashboard/profile/components/profile-avatar-display.tsx`

- [ ] **步骤 5.1：写 `profile-avatar-display.tsx`**

把"头像预览 + 缓存说明"挪出来，纯展示 + onAvatarUpdated 回调（用于上传后通知 sidebar）：

```tsx
'use client'

import * as React from 'react'
import { Camera } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { type CachedAvatar, loadUserAvatar } from '@/lib/user-avatar-cache'

interface ProfileAvatarDisplayProps {
  userId: string | null
  avatarUrl: string | null
  refreshTick: number
}

export function ProfileAvatarDisplay({ userId, avatarUrl, refreshTick }: ProfileAvatarDisplayProps) {
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null)
  const [previewFromCache, setPreviewFromCache] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let activeUrl: string | null = null

    if (!userId || !avatarUrl) {
      setPreviewSrc(null)
      setPreviewFromCache(false)
      return
    }

    loadUserAvatar(userId, avatarUrl)
      .then((cached: CachedAvatar | null) => {
        if (cancelled || !cached) return
        activeUrl = cached.objectUrl
        setPreviewSrc(cached.objectUrl)
        setPreviewFromCache(cached.fromCache)
      })
      .catch(() => {
        // Failure to decode is non-fatal: avatar component falls back to initials.
      })

    return () => {
      cancelled = true
      if (activeUrl) URL.revokeObjectURL(activeUrl)
    }
  }, [userId, avatarUrl, refreshTick])

  return (
    <div className="flex flex-col items-center gap-3">
      <Avatar className="h-40 w-40 rounded-2xl border border-border/60 shadow-sm">
        {previewSrc ? <AvatarImage src={previewSrc} alt="当前头像" /> : null}
        <AvatarFallback className="rounded-2xl bg-muted text-3xl font-semibold text-muted-foreground">
          <Camera className="h-12 w-12" />
        </AvatarFallback>
      </Avatar>
      <p className="text-xs text-muted-foreground">
        {previewFromCache ? '已从本地缓存加载' : avatarUrl ? '已从 R2 加载' : '尚未上传头像'}
      </p>
    </div>
  )
}
```

- [ ] **步骤 5.2：重写 `profile-avatar-tab.tsx`**

把"上传/删除 actions"留在这里，data 从 props 拿，行为不变：

```tsx
'use client'

import * as React from 'react'
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  deleteAvatar,
  uploadAvatar,
} from '@/lib/client-api/profile-client'
import { invalidateUserAvatar } from '@/lib/user-avatar-cache'
import type { Profile } from '@/types/profile'

import { ProfileAvatarDisplay } from './profile-avatar-display'
import { ProfileAvatarSkeleton } from './profile-skeletons'

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const ACCEPTED_EXT_LABEL = 'PNG / JPG / WEBP / GIF'
const MAX_BYTES = 5 * 1024 * 1024

interface ProfileAvatarTabProps {
  profile: Profile | null
  loading: boolean
  onRefetch: () => Promise<void>
}

export function ProfileAvatarTab({ profile, loading, onRefetch }: ProfileAvatarTabProps) {
  const { notify } = useNotifications()
  const [uploading, setUploading] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [refreshTick, setRefreshTick] = React.useState(0)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const userId = profile?.id ?? null
  const avatarUrl = profile?.avatar_url ?? null

  const onPickFile = () => {
    fileInputRef.current?.click()
  }

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!ACCEPTED_MIME.includes(file.type)) {
      notify({ type: 'error', title: `不支持的文件类型：${file.type || '未知'}` })
      return
    }
    if (file.size > MAX_BYTES) {
      notify({ type: 'error', title: `头像大小不能超过 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB` })
      return
    }

    setUploading(true)
    try {
      await uploadAvatar(file)
      if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
      await onRefetch()
      notify({ type: 'success', title: '头像已更新' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '上传失败') })
    } finally {
      setUploading(false)
    }
  }

  const onRemove = async () => {
    if (!avatarUrl) return
    setRemoving(true)
    try {
      await deleteAvatar()
      if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
      await onRefetch()
      notify({ type: 'success', title: '已恢复默认头像' })
    } catch (err) {
      notify({ type: 'error', title: normalizeErrorMessage(err, '删除失败') })
    } finally {
      setRemoving(false)
    }
  }

  const onRefresh = () => {
    if (userId && avatarUrl) invalidateUserAvatar(userId, avatarUrl)
    setRefreshTick((tick) => tick + 1)
    notify({ type: 'info', title: '正在重新获取头像...' })
  }

  if (loading && !profile) {
    return <ProfileAvatarSkeleton />
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <ProfileAvatarDisplay userId={userId} avatarUrl={avatarUrl} refreshTick={refreshTick} />

      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
          <p className="text-sm font-medium">上传新头像</p>
          <p className="mt-1 text-xs text-muted-foreground">
            支持 {ACCEPTED_EXT_LABEL} 格式，单张图片最大 {MAX_BYTES / 1024 / 1024}MB。
            图片会保存到 Cloudflare R2，并自动在浏览器本地缓存以加速加载。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" onClick={onPickFile} disabled={uploading || removing}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? '上传中...' : avatarUrl ? '替换头像' : '上传头像'}
            </Button>
            {avatarUrl ? (
              <>
                <Button type="button" variant="outline" onClick={onRefresh} disabled={uploading || removing}>
                  <RefreshCw className="h-4 w-4" />
                  刷新
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemove}
                  disabled={uploading || removing}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {removing ? '删除中...' : '删除头像'}
                </Button>
              </>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_MIME.join(',')}
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        <div className="rounded-lg border border-border/40 bg-card/40 p-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">缓存说明</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>首次上传后，浏览器会自动从 R2 下载一次图片并存到本地 sessionStorage。</li>
            <li>下次刷新或重新打开页面时优先使用本地缓存，避免重复网络请求。</li>
            <li>关闭浏览器标签后本地缓存会被清空，再次访问会重新下载。</li>
            <li>上传新头像后会自动失效旧缓存，无需手动刷新。</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **步骤 5.3：lint + build**

```bash
cd frontend && pnpm lint 2>&1 | tail -10
cd frontend && pnpm build 2>&1 | tail -20
```

---

## 任务 6：projects tab 切 DataTableCard + 移动端卡片列表

### 文件
- 重写：`frontend/app/dashboard/profile/components/profile-projects-tab.tsx`
- 新建：`frontend/app/dashboard/profile/components/profile-projects-card.tsx`

- [ ] **步骤 6.1：写 `profile-projects-card.tsx`**

移动端卡片列表（参考 `account-management/page.tsx:412-477` 模式）：

```tsx
'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

import type { ProjectItem } from './profile-projects-tab-shared' // 抽 type 见下

interface ProfileProjectsCardProps {
  items: ProjectItem[]
  operatorNames: string[]
  isAdmin: boolean
  deriveRole: (item: ProjectItem, names: string[]) => string | null
}

export function ProfileProjectsCard({ items, operatorNames, isAdmin, deriveRole }: ProfileProjectsCardProps) {
  return (
    <div className="md:hidden space-y-3">
      {items.map((item) => {
        const role = isAdmin ? '管理员' : deriveRole(item, operatorNames)
        return (
          <div key={item.id} className="dashboard-surface p-4 space-y-3">
            <div className="flex items-start justify-between gap-2 border-b border-border/70 pb-3">
              <div>
                <div className="font-semibold">{item.name}</div>
                <div className="text-xs text-muted-foreground">
                  {item.brand_name || '—'} · {item.store_address || '—'}
                </div>
              </div>
              {item.project_tier ? (
                <Badge variant="outline">{item.project_tier}</Badge>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">状态</div>
                <Badge variant={item.is_active ? 'default' : 'secondary'} className={item.is_active ? '' : 'opacity-70'}>
                  {item.is_active ? '启用' : '停用'}
                </Badge>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">我的角色</div>
                {role ? (
                  <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">{role}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">佣金比例</div>
                <div>{formatCommission(item.commission_basis, item.commission_rate)}</div>
              </div>
            </div>

            <Link
              href={`/dashboard/system-management/project-info?projectId=${item.id}`}
              className="inline-flex h-9 min-h-[44px] items-center gap-1 text-xs text-primary hover:underline"
            >
              查看项目
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        )
      })}
    </div>
  )
}

function formatCommission(basis: string | null, rate: number | null): string {
  if (rate === null) return '—'
  const pct = (rate * 100).toFixed(2)
  const basisLabel = basis ? COMMISSION_BASIS_LABEL[basis] ?? basis : null
  return basisLabel ? `${pct}% · ${basisLabel}` : `${pct}%`
}

const COMMISSION_BASIS_LABEL: Record<string, string> = {
  sales_amount: '销售额',
  cash_received: '平台回款',
  profit_margin: '利润率',
}
```

> 类型共享：把 `ProjectItem`、`TIER_BADGE_CLASS`、`COMMISSION_BASIS_LABEL`、`splitNames`、`deriveRole`、`formatCommission` 全部搬到 `profile-projects-tab-shared.ts`（避免 cards 和 tabs 互相 import 制造循环）。

- [ ] **步骤 6.2：建共享文件 `profile-projects-tab-shared.ts`**

```ts
export interface ProjectItem {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  project_operator: string | null
  assistant_operator: string | null
  commission_basis: string | null
  commission_rate: number | null
  is_active: boolean
  project_tier: string | null
}

export type ProjectRole = '主运营' | '助理运营' | null

export const COMMISSION_BASIS_LABEL: Record<string, string> = {
  sales_amount: '销售额',
  cash_received: '平台回款',
  profit_margin: '利润率',
}

export const TIER_BADGE_CLASS: Record<string, string> = {
  T1: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800',
  T2: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  T3: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  T4: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300 border-slate-200 dark:border-slate-800',
}

const OPERATOR_SPLIT_RE = /[、,，;\n]+/

export function splitNames(value: string | null): string[] {
  if (!value) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value.split(OPERATOR_SPLIT_RE)) {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function deriveRole(item: ProjectItem, operatorNames: string[]): ProjectRole {
  if (!operatorNames.length) return null
  if (splitNames(item.project_operator).some((n) => operatorNames.includes(n))) return '主运营'
  if (splitNames(item.assistant_operator).some((n) => operatorNames.includes(n))) return '助理运营'
  return null
}

export function formatCommission(basis: string | null, rate: number | null): string {
  if (rate === null) return '—'
  const pct = (rate * 100).toFixed(2)
  const basisLabel = basis ? COMMISSION_BASIS_LABEL[basis] ?? basis : null
  return basisLabel ? `${pct}% · ${basisLabel}` : `${pct}%`
}
```

- [ ] **步骤 6.3：重写 `profile-projects-tab.tsx`**

```tsx
'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

import { ProfileProjectsCard } from './profile-projects-card'
import { ProfileProjectsSkeleton } from './profile-skeletons'
import {
  type ProjectItem,
  TIER_BADGE_CLASS,
  deriveRole,
  formatCommission,
} from './profile-projects-tab-shared'

interface ProfileProjectsTabProps {
  profile: { name?: string | null; roleType?: string | null; operatorNameZh?: string | null } | null
}

export function ProfileProjectsTab({ profile }: ProfileProjectsTabProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const [items, setItems] = React.useState<ProjectItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const operatorNames = React.useMemo(() => {
    const candidates = [profile?.operatorNameZh, profile?.name]
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of candidates) {
      if (!value) continue
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
    return result
  }, [profile])

  React.useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    fetchManagedProjectsCached<ProjectItem[]>(session, true)
      .then((data) => {
        if (cancelled) return
        setItems(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = normalizeErrorMessage(err, '项目列表加载失败')
        setError(message)
        notify({ type: 'error', title: message })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  if (error && !items) {
    return (
      <div className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (items === null) {
    return <ProfileProjectsSkeleton />
  }

  const isAdmin = session?.user?.roleType === 'admin'
  const visibleItems = isAdmin ? items : items.filter((item) => deriveRole(item, operatorNames) !== null)

  if (visibleItems.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        暂无可管理的项目。如果你认为自己应该出现在这里，请联系管理员核对运营 / 助理运营名是否一致。
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <DataTableCard>
        <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold">项目列表</span>
          <span className="text-xs text-muted-foreground">共 {visibleItems.length} 个项目</span>
        </DataTableCardHeader>
        <DataTableCardBody>
          {/* Desktop */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目名</TableHead>
                  <TableHead>品牌</TableHead>
                  <TableHead>店铺地址</TableHead>
                  <TableHead>等级</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>我的角色</TableHead>
                  <TableHead>佣金比例</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.map((item) => {
                  const role = isAdmin ? '管理员' : deriveRole(item, operatorNames)
                  const tierClass = item.project_tier ? TIER_BADGE_CLASS[item.project_tier] : ''
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium text-foreground">{item.name}</TableCell>
                      <TableCell className="text-muted-foreground">{item.brand_name || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{item.store_address || '—'}</TableCell>
                      <TableCell>
                        {item.project_tier ? (
                          <Badge variant="outline" className={tierClass}>{item.project_tier}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.is_active ? 'default' : 'secondary'} className={item.is_active ? '' : 'opacity-70'}>
                          {item.is_active ? '启用' : '停用'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {role ? (
                          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">{role}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatCommission(item.commission_basis, item.commission_rate)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/dashboard/system-management/project-info?projectId=${item.id}`}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          查看
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile */}
          <ProfileProjectsCard
            items={visibleItems}
            operatorNames={operatorNames}
            isAdmin={isAdmin}
            deriveRole={(item, names) => deriveRole(item, names)}
          />
        </DataTableCardBody>
      </DataTableCard>

      {!isAdmin && operatorNames.length === 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          ⚠ 当前账号未设置运营名，列表为空。
        </p>
      ) : null}
    </div>
  )
}
```

> 注意：`ProfileProjectsCard` 接收的 `profile` prop 形状用最小子集（`name` / `operatorNameZh`），跟实际 `Profile` 完全兼容 —— TypeScript 结构化类型会自动收窄。

- [ ] **步骤 6.4：lint + build**

```bash
cd frontend && pnpm lint 2>&1 | tail -20
cd frontend && pnpm build 2>&1 | tail -20
```

预期：lint + build 通过。如 `useProfile()` 返回的 `profile` 类型不含 `operatorNameZh` 字段，请扩展 `Profile` 接口或调整 `useProfile` 消费方式 —— 实际上是有的（next-auth 通过 session 推 `operatorNameZh`），见 `use-session.ts` 类型定义。

---

## 任务 7：UI 验证 + 收尾

### 文件
- 不变（仅验证）：上面所有文件。

- [ ] **步骤 7.1：跑完整 lint + build**

```bash
cd frontend && pnpm lint 2>&1 | tail -30
cd frontend && pnpm build 2>&1 | tail -30
```

预期：0 error。如果只剩 warning（unrelated to profile），记下来但不动。

- [ ] **步骤 7.2：手动验证 `/dashboard/profile`**

按规格 §6 业务测试清单 1–15 项逐一跑，记录 PASS / FAIL。失败项立即修。

- [ ] **步骤 7.3：检查没有遗留的死代码 / 未用导出**

```bash
cd frontend && rg "ProfileResponse|ProjectItem" app/dashboard/profile/ lib/
```

预期：除 `types/profile.ts` 的 `Profile` 外，3 个 tab 文件不应该再有 `ProfileResponse` / `ProjectItem` 局部声明。如发现，删除。

---

## 收尾

- [ ] **步骤 8.1：commit + push**

按 `CLAUDE.md` Git 提交规范：

```bash
git add frontend/types/profile.ts frontend/lib/client-api/profile-client.ts frontend/lib/hooks/use-profile.ts frontend/app/dashboard/profile/
git status --short
git -c user.name="Seth" -c user.email="seth@believeboy.dev" commit -m "refactor(BEL-143): 重构 user info 页面

- 切到 DataCard + SlidingTabsTrigger + Table，与 operator-management 对齐
- 新增 useProfile hook + profile 类型，三个 tab 共用单一 fetch 源
- 拆出 6 个小组件：form/display/card/stats/skeletons/shared
- 加 per-tab skeleton + 移动端项目卡片列表
- 替换通用 DashboardPageLoading 为 ProfileInfoSkeleton"
```

- [ ] **步骤 8.2：触发 post-push hook（按 CLAUDE.md）**

```bash
git push origin agent/seth/9e65f7eb
.git/hooks/post-push "refs/heads/agent/seth/9e65f7eb" "https://github.com/passwii/believeboyDashboard.git"
```

- [ ] **步骤 8.3：回复用户（在 BEL-143 上 post 一个结果 comment）**

内容模板：

```
## 重构完成

按设计文档执行完毕：
- ✅ UI 切到 DataCard + SlidingTabsTrigger + Table
- ✅ useProfile hook + 共享类型，3 tab 单一 fetch 源
- ✅ 拆出 stats / display / card / skeletons 6 个子组件
- ✅ per-tab skeleton + 移动端项目卡片
- ✅ pnpm lint + pnpm build 通过

附上：
- 设计文档：[链接]
- 实现计划：[链接]
- 业务测试清单（请用户手动跑 15 项）：[链接]
```

按你的命令格式约定：**不要 @mention 触发者**（CLAUDE.md 提示：这是为了避免循环）。

