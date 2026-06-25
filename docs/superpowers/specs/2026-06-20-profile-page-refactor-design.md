# User Info 页面重构规格（BEL-143）

> 目标：将 `/dashboard/profile` 三 tab 页面与项目内其他 dashboard 页面（`operator-management`、`account-management`）的设计系统、组件库、数据层约定对齐，并清理 2 天前 a20fcc4 提交时遗留的代码组织与重复 fetch 问题。

## 1. 背景

- 当前页面由 2026-06-18 的 a20fcc4 提交（`feat(user-center): add profile page with info/avatar/projects tabs`）引入，落地速度优先于一致性。
- 同期/稍后的提交已经把"个人资料""系统管理"等页面切到 `DataCard` + `SlidingTabsTrigger` + `Table` 体系（见 `operator-management`、`account-management`、`data-analysis/*`），但 profile 页没跟上。
- 用户已确认本次重构走"全部一起做"：UI 对齐 + 代码组织 + 数据层 + 移动端 + 共享类型 + per-tab skeleton。

## 2. 范围

**In scope：**
- `frontend/app/dashboard/profile/` 下全部 5 个文件（`page.tsx`、`profile-client.tsx`、`loading.tsx`、3 个 tab 组件）。
- 新增 1 个共享类型文件 + 1 个数据 hook + 1 个 client-api 包装。
- 新增 3 个 per-tab skeleton（profile 专用）。
- `/api/user/profile`、`/api/user/avatar` 前端消费路径不变（API 已稳定，不动 backend）。

**Out of scope（明确不做）：**
- 后端 `app/api/v1/endpoints/profile.py`、`app/schemas/profile.py`、`app/services/upload_service.py`：不动。
- `frontend/app/api/user/profile/route.ts`、`frontend/app/api/user/avatar/route.ts`：不动（薄薄一层转发，不是 refactor 目标）。
- 头像 R2 上传/缓存逻辑：行为不变，只拆组件。
- 增/改密码流程的合并：暂不把"修改密码"内嵌进 profile 页；保留 `frontend/app/dashboard/change-password/page.tsx` 单独入口 + profile 页脚链接（保持 a20fcc4 既定 UX）。
- 新建 SWR / React Query 依赖（项目无此类依赖，见 `frontend/package.json`）。

## 3. 现状问题（按文件）

| 文件 | 行数 | 问题 |
|---|---|---|
| `profile-client.tsx` | 121 | 用旧 `Card` + 渐变 `linear-gradient` 内联 class，没有用 `DataCard`；`TabsList` 用默认样式，没接 `TabsMotionGroup` / `SlidingTabsTrigger`；`Tabs` 用 radix 原生 `TabsTrigger` |
| `components/profile-info-tab.tsx` | 244 | 单文件塞了 form + 角色/状态/改密时间 3 个 stats cards；自带 `fetch('/api/user/profile')`；type `ProfileResponse` 重复声明 |
| `components/profile-avatar-tab.tsx` | 245 | 单文件塞了容器 + 上传按钮 + R2 缓存说明；自带 `fetch('/api/user/profile')`（与 info tab 重复）；用 `refreshTick` 自己实现 refetch |
| `components/profile-projects-tab.tsx` | 240 | 用原生 `<table>`；没有移动端卡片布局；type `ProjectItem` 重复声明；operator_names 匹配逻辑写在组件里，未来复用难 |
| `loading.tsx` | 5 | 复用 `DashboardPageLoading`（dashboard 首页骨架），与 profile 实际布局毫无关系，会误导用户 |
| `page.tsx` | 5 | 不动（薄壳） |

## 4. 目标架构

### 4.1 组件树

```
ProfilePage (page.tsx, server component, 不变)
└── ProfileClient (profile-client.tsx, 'use client')
    ├── DataCard
    │   ├── DataCardHeader  (badge + title + role badge)
    │   └── DataCardContent
    │       ├── Tabs (URL search param 'tab' 同步)
    │       │   ├── TabsList + TabsMotionGroup
    │       │   │   ├── SlidingTabsTrigger value="info"
    │       │   │   ├── SlidingTabsTrigger value="avatar"
    │       │   │   └── SlidingTabsTrigger value="projects"
    │       │   ├── TabsContent value="info"     → <ProfileInfoTab />
    │       │   ├── TabsContent value="avatar"   → <ProfileAvatarTab />
    │       │   └── TabsContent value="projects" → <ProfileProjectsTab />
    └── Footer link (修改密码)
```

### 4.2 文件结构（最终落点）

```
frontend/app/dashboard/profile/
  page.tsx                       (不变 — 5 行)
  profile-client.tsx             (121 → ~95 行,DataCard + SlidingTabsTrigger)
  loading.tsx                    (5 → 5 行,改用 ProfilePageSkeleton)
  components/
    profile-shared.ts            (新 — 类型 + 角色 label map + 工具函数)
    profile-info-tab.tsx         (244 → ~150 行,只保留 form)
    profile-info-stats.tsx       (新,从 info-tab 拆出 — 角色/状态/改密时间)
    profile-avatar-tab.tsx       (245 → ~120 行,容器 + 上传/删除 actions)
    profile-avatar-display.tsx   (新,从 avatar-tab 拆出 — 头像预览 + R2 cache 说明)
    profile-projects-tab.tsx     (240 → ~150 行,DataTableCard + Table 组件)
    profile-projects-card.tsx    (新,移动端卡片列表)
    profile-skeletons.tsx        (新,3 个 per-tab skeleton)

frontend/lib/hooks/use-profile.ts             (新 — 数据 hook)
frontend/lib/client-api/profile-client.ts     (新 — fetch 包装 + clientCache)
frontend/types/profile.ts                     (新 — Profile / ProfileUpdate 类型)
```

### 4.3 数据流

- 顶层 `ProfileClient` 调一次 `useProfile()` 拿 profile，3 个 tab 通过 props 拿 `profile` / `refetch` / `update`，不再各自 fetch `/api/user/profile`。
- `update` 调 PATCH，成功后 mutate 本地 state + 调 `useSession().update({ user: { name, image } })` 同步 sidebar。
- 头像上传成功后 `refetch()` 触发整页 profile 更新；`onAvatarUpdated` 仍由 `useSession` 同步 sidebar 头像（关键路径，保留）。
- URL `?tab=info|avatar|projects` 同步（已实现，保留）：通过 `useSearchParams` + `router.replace(..., { scroll: false })`，默认 `info`。
- 项目列表：复用现有 `fetchManagedProjectsCached`，不变。

### 4.4 共享类型（`frontend/types/profile.ts`）

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

`ProfileResponse`（3 个 tab 文件里的局部接口）→ 全部用 `Profile`。snake_case 后端字段保留在内部 parse 层；组件消费统一 camelCase（如果未来要做彻底转换，可作为单独 PR，本次不动）。

### 4.5 `useProfile` hook（`frontend/lib/hooks/use-profile.ts`）

```ts
interface UseProfileResult {
  profile: Profile | null
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  update: (patch: ProfileUpdate) => Promise<Profile>
}
```

实现要点：
- 内部用 `useSession()` 拿 session；session 没准备好不发起请求。
- 缓存：1 分钟内存缓存（不持久化到 sessionStorage —— profile 修改后要快速看到新值）。
- 错误向上抛给调用方（与 `useManagedProjects` 风格一致），由组件决定是否 `notify`。
- `update()`：先 PATCH，成功后 setState + 不依赖 refetch（避免再次 fetch 造成竞态）。
- 单一 fetch 源：3 个 tab 不再各自调 `/api/user/profile`。

### 4.6 `client-api/profile-client.ts`（薄包装）

- `fetchProfile()` / `updateProfile(patch)` / `uploadAvatar(file)` / `deleteAvatar()`：每个函数透传到 `/api/user/...` 路由 + 处理 error normalize。
- 不引入新依赖，复用现有 `normalizeErrorMessage`、`buildBackendClientHeaders` 模式（与 `project-client-cache.ts` 对齐）。
- `uploadAvatar` 不做 multipart 重建（交给 `/api/user/avatar` route.ts），前端只 `FormData`。

### 4.7 Skeleton（`components/profile-skeletons.tsx`）

3 个 per-tab skeleton：
- `ProfileInfoSkeleton`：4 个 Input skeleton + 1 个 stats 三列 skeleton。
- `ProfileAvatarSkeleton`：200×200 头像方块 + 操作按钮 skeleton。
- `ProfileProjectsSkeleton`：基于 `TableSkeletonRows columns=7 rows=5`（与新表格对齐）。

`loading.tsx` 改为渲染 `ProfileInfoSkeleton`（默认 tab 即 info）。

### 4.8 移动端（MOBILE_ADAPTATION_RULES.md 规则 1）

`profile-projects-tab.tsx`：
- `<768px`：隐藏 `Table`，渲染 `<ProfileProjectsCard>` 卡片列表（每张卡含项目名 / 等级 / 状态 / 我的角色 / 佣金 / 跳转链接，遵循 `account-management` 移动端布局）。
- `≥768px`：隐藏卡片，渲染 `Table`。
- 表格列数 ≥5，符合规则 1 的适用条件。

`profile-info-tab.tsx`：form 已是 `grid-cols-1 md:grid-cols-2`，无需改动；统计卡 `grid-cols-1 md:grid-cols-3` 也已响应式，不动。

`profile-avatar-tab.tsx`：`grid-cols-1 md:grid-cols-[200px_1fr]`，不动。

## 5. 视觉细节

- `DataCard` 替换旧 `Card` + 自定义渐变：使用 `DataCardHeader`（title + badge + description + action）+ `DataCardContent` 默认 padding。`profile-client.tsx` 顶部的 "个人中心 / 我的资料" 卡片统一走 `DataCard`，badge "个人中心" 用 `border-cyan-500/30 bg-cyan-500/10` 与 `account-management` 对齐。
- `TabsList` 改成 `rounded-2xl border border-border/70 bg-muted/25 p-1`（从 `operator-management` 复制），3 个 `SlidingTabsTrigger` 用同一 `layoutId="profile-tabs"`。
- 角色 badge：保留右上角 `Badge` 显式显示（`admin / 运营 / 招商`），与 sidebar 的 `roleLabel` 视觉一致。

## 6. 测试 / 验收

按 `CLAUDE.md` 测试规则：

**技术测试（每次必做）：**
```bash
cd frontend && pnpm lint
cd frontend && pnpm build
```

**业务测试清单（交给用户手动执行）：**

1. `/dashboard/profile` 默认进入"资料设置" tab。
2. 顶部 URL 同步：`/dashboard/profile?tab=avatar` 直接打开头像 tab；刷新后保持。
3. 切到"我的项目" tab：管理员看见所有项目；运营/招商看见自己作为运营或助理的项目；空状态出现 "暂无可管理的项目" 提示。
4. 移动端（<768px）打开"我的项目"：表格隐藏，卡片列表渲染；点击卡片"查看"链接跳转 `project-info?projectId=...`。
5. 头像 tab：上传 PNG/JPG/WEBP/GIF 之一（≤5MB）→ 头像更新 + sidebar 头像同步 + "已从 R2 加载"提示。
6. 头像 tab：点"刷新"按钮 → 重新拉头像（`refreshTick` 行为保留）。
7. 头像 tab：点"删除头像" → 头像恢复默认 + sidebar 头像同步恢复首字母。
8. 资料 tab：清空"显示名"点保存 → "姓名不能为空"通知；正常输入点保存 → "资料已保存"通知 + sidebar 用户名同步。
9. 资料 tab：邮箱框始终 disabled（不可改）。
10. 资料 tab："运营名（中文）" 提示文案在 light / dark mode 下都能看清。
11. 从 sidebar 用户面板 → "个人资料" 链接点击进入，仍走 `RouteLoadingLink`（过渡不卡）。
12. 跨会话：同一用户开两个浏览器窗口，A 改名 → B 不刷新看不到（profile 缓存 60s 内生效，符合预期；超 60s 切换 tab 触发 refetch 即可看到）。
13. 错误路径：临时拔掉 backend，`/api/user/profile` 返回 500 → 三个 tab 都不崩；`info` tab 显示 "无法加载个人资料，请稍后重试"，avatar/projects 各自有错误态。
14. ESLint：`useEffect` 依赖里 `notify` / `refetch` 引用稳定，不出现 lint 警告。
15. 可访问性：键盘 Tab 可遍历 3 个 tab + 表单字段 + 头像操作按钮；radix `Tabs` 提供 `role="tablist"` / `role="tab"` 已默认满足。

## 7. 风险与回滚

- 风险点：URL `?tab=` 切换 / `useSession().update` 调用顺序变了 → 头像/改名后 sidebar 同步失效。
  - 缓解：测试清单第 5/6/7/8 项必须通过；如失败回滚到 a20fcc4 即可（git revert 即可，profile 页是单页单 PR）。
- 风险点：抽 `useProfile` 后，3 个 tab 共用同一份 profile → 任意 tab 修改后其他 tab 立即看到（新行为，符合预期；测试清单第 12 项覆盖）。
- 风险点：移动端卡片 → 链接区域需要 `min-h-[44px]`（规则 5）；`profile-projects-card.tsx` 内"查看"按钮独立保证 44×44。

## 8. 不在本次范围（未来可做）

- 把"修改密码"内嵌进 profile 页（减小 sidebar 跳转）。
- 加"登录历史 / 设备列表" tab（需后端支持）。
- 把 `user-avatar-cache.ts`（R2 二进制缓存）从 `lib/` 提到 `lib/avatar/` 子目录统一管理。
- `Profile` 类型 camelCase 转换（破坏现有 `ProfileResponse` 接口，需联动 backend 改 schema，独立 PR）。

---

## 规格自检

| 检查项 | 结果 |
|---|---|
| 占位符 / "待定" / TODO | 无 |
| 内部一致性 | 数据层 → 组件 props → UI 三段描述一致；URL 状态 / useSession 同步路径在多处一致 |
| 范围聚焦 | 单页重构 + 配套 hook/types，能在 1 个实现计划里覆盖 |
| 模糊性 | "Snake_case 后端字段保留内部 parse 层"已明确为"本次不做 camelCase 转换" |