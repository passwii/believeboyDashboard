# 主题切换迁移到 Sidebar User 模块 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Dashboard 顶栏的 Dark/Light Mode 切换控件迁移到 Sidebar 底部 `NavUser` 头像下拉菜单中作为"外观"子菜单，保留三选项（浅色 / 深色 / 跟随系统）。

**架构：** 复用现有 `next-themes` 的 `useTheme` Hook 和 `ThemeToggle` 中已验证的 `mounted` 防 hydration 模式，仅做位置迁移。在 `NavUser` 的 DropdownMenu 中插入一个 `DropdownMenuSub`（外观），子菜单三项为 `DropdownMenuItem`，带 ✓ 选中标记。同时从 `app/dashboard/layout.tsx` 删除两处 `<ThemeToggle />` 引用和对应 import。

**技术栈：** Next.js 14 App Router、React 18、`@radix-ui/react-dropdown-menu`、`next-themes`、Tailwind CSS、shadcn/ui 风格组件。

**参考文档：**
- 设计：`docs/superpowers/specs/2026-06-03-theme-toggle-relocation-design.md`
- 原组件：`frontend/components/theme-toggle.tsx`
- 现有 `NavUser`：`frontend/components/dashboard/nav-user.tsx`
- 现有 `layout`：`frontend/app/dashboard/layout.tsx`

---

## 文件结构

本任务**不创建新文件**，只修改 2 个现有文件：

| 文件 | 变更 |
|------|------|
| `frontend/components/dashboard/nav-user.tsx` | 在 dropdown 中插入"外观" `DropdownMenuSub`，含三选项。引入 `useTheme`、`useState`、`useEffect` 以及 `Check/Monitor/Moon/SunMedium` 图标、`DropdownMenuSub/SubTrigger/SubContent` 组件 |
| `frontend/app/dashboard/layout.tsx` | 删除 1 个 `import` + 桌面和移动端两处 `<ThemeToggle />` 引用 |

**保留但不使用：**
- `frontend/components/theme-toggle.tsx` — 保留文件不删（未来可能复用），仅 `layout.tsx` 不再引用

---

## 任务 1：在 `NavUser` 中加入"外观"子菜单

**文件：**
- 修改：`frontend/components/dashboard/nav-user.tsx`

- [ ] **步骤 1：在文件顶部补全 import**

将文件顶部现有 import 区域（当前第 1-17 行）扩展为如下完整列表（保留原有所有 import，新增项以注释 `// ADDED:` 标出）：

```tsx
'use client'

import { useEffect, useState } from 'react'                                      // ADDED
import { Check, Factory, KeyRound, LogOut, Monitor, Moon, Shield, Store, SunMedium } from 'lucide-react'  // ADDED: Check, Monitor, Moon, SunMedium
import { ChevronsUpDown } from 'lucide-react'
import { useTheme } from 'next-themes'                                          // ADDED

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,                // ADDED
  DropdownMenuSubContent,        // ADDED
  DropdownMenuSubTrigger,        // ADDED
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
```

- [ ] **步骤 2：在 `NavUser` 函数体顶部加入主题 Hook 与 mounted 状态**

将 `NavUser` 函数体开头（第 45-48 行）扩展为：

```tsx
export function NavUser({ user, onLogout }: NavUserProps) {
  const { isMobile } = useSidebar()
  const fallback = user.name?.[0]?.toUpperCase() || 'U'
  const roleLabel = user.roleType ? ROLE_LABELS[user.roleType] : null

  // Theme: reuse ThemeToggle pattern to avoid hydration mismatch
  const { theme, setTheme } = useTheme()                                    // ADDED
  const [mounted, setMounted] = useState(false)                              // ADDED
  useEffect(() => {                                                          // ADDED
    setMounted(true)                                                         // ADDED
  }, [])                                                                     // ADDED
  const currentTheme = mounted ? theme : 'system'                            // ADDED
```

- [ ] **步骤 3：在 dropdown 中插入"外观"子菜单**

定位到现有 `<DropdownMenuGroup>` 包裹"修改密码"那一段（约 92-99 行），在该 `<DropdownMenuGroup>` **之前**插入"外观"子菜单块。完整修改后该区域代码应为：

```tsx
            <DropdownMenuSeparator />
            {/* Theme: 外观 sub menu */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunMedium />
                <span>外观</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => setTheme('light')}>
                  <SunMedium />
                  <span>浅色</span>
                  {currentTheme === 'light' ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('dark')}>
                  <Moon />
                  <span>深色</span>
                  {currentTheme === 'dark' ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('system')}>
                  <Monitor />
                  <span>跟随系统</span>
                  {currentTheme === 'system' ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <RouteLoadingLink href="/dashboard/change-password">
                  <KeyRound />
                  修改密码
                </RouteLoadingLink>
              </DropdownMenuItem>
            </DropdownMenuGroup>
```

注意：第 91 行原本的 `<DropdownMenuSeparator />` 保留（位于头像区与外观之间），新加的 `<DropdownMenuSeparator />` 放在外观与修改密码之间。

- [ ] **步骤 4：查看完整 diff 确认结构正确**

运行：`git diff frontend/components/dashboard/nav-user.tsx`
预期：只看到上述三处插入，无删除现有代码（除可能的空行/格式变化）。

- [ ] **步骤 5：Commit**

```bash
git add frontend/components/dashboard/nav-user.tsx
git commit -m "$(cat <<'EOF'
feat(ui): 在 Sidebar User dropdown 加入外观子菜单

将原顶栏主题切换控件改为子菜单形式（浅色/深色/跟随系统），
保留 next-themes 的 mounted 防 hydration 模式。
EOF
)"
```

---

## 任务 2：从 dashboard layout 中移除 ThemeToggle 引用

**文件：**
- 修改：`frontend/app/dashboard/layout.tsx`

- [ ] **步骤 1：删除 ThemeToggle import**

定位到第 21 行：

```tsx
import { ThemeToggle } from '@/components/theme-toggle'
```

整行删除。

- [ ] **步骤 2：删除桌面工具栏中的 ThemeToggle**

定位到第 302 行（在 `<DesktopPinnedItems />` 与 `<NotificationBell />` 之间）：

```tsx
              <div className="flex items-center justify-end gap-2">
                <ThemeToggle />
                <NotificationBell />
                <RecentPagesDropdown />
```

将 `<ThemeToggle />` 整行删除，留下：

```tsx
              <div className="flex items-center justify-end gap-2">
                <NotificationBell />
                <RecentPagesDropdown />
```

- [ ] **步骤 3：删除移动端折叠工具栏中的 ThemeToggle**

定位到第 348 行（在移动端折叠工具栏的 `<div className="flex items-center justify-end gap-2 px-2 py-2.5">` 内）：

```tsx
              <ThemeToggle />
              <NotificationBell />
```

将 `<ThemeToggle />` 整行删除，留下：

```tsx
              <NotificationBell />
```

- [ ] **步骤 4：确认无残留引用**

运行：
```bash
cd frontend && grep -rn "ThemeToggle" app/ components/dashboard/ 2>/dev/null
```
预期：无输出（`ThemeToggle` 组件文件 `components/theme-toggle.tsx` 仍然存在但无任何引用 — 这是预期状态）。

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/layout.tsx
git commit -m "$(cat <<'EOF'
refactor(ui): 从 dashboard 顶栏移除 ThemeToggle 引用

主题切换已迁到 Sidebar User dropdown，删除桌面与移动端
两处 ThemeToggle 引用及对应 import。
EOF
)"
```

---

## 任务 3：构建验证与 lint

- [ ] **步骤 1：运行前端构建**

运行：
```bash
cd frontend && pnpm build
```

预期：构建成功，无 TypeScript / 编译错误。

如果失败：
- `useTheme` / `DropdownMenuSub` 未找到 → 检查 import 路径
- 类型错误 → 检查 `theme` 是否为 `string | undefined`，已通过 `mounted` 保护
- Hydration 警告 → 已通过 `mounted` flag 保护

- [ ] **步骤 2：运行 lint**

运行：
```bash
cd frontend && pnpm lint
```

预期：与 main 分支相比无新增 warning/error（ununsed import 已清除）。

- [ ] **步骤 3：人工业务测试（按设计文档 §6.2 清单）**

将设计文档中 §6.2 的 10 项业务测试清单原样发给用户手动执行并收集反馈。

---

## 自检报告

**1. 规格覆盖度：**
- §3 dropdown 新结构 → 任务 1 步骤 3
- §4.1 主题状态来源 → 任务 1 步骤 2
- §4.2 子菜单实现 → 任务 1 步骤 3
- §4.3 layout.tsx 删除项 → 任务 2 步骤 1-3
- §6 测试 → 任务 3 步骤 1-3
- §7 验收标准 → 任务 3 步骤 1-3（build 通过 + 业务测试清单反馈）

**2. 占位符扫描：** 无 "TODO" / "待定" / "类似任务 N"。

**3. 类型一致性：**
- `useTheme` 返回 `{ theme, setTheme }` — 任务 1 步骤 2 与 §4.1 一致
- `currentTheme` 计算与 `ThemeToggle` 原代码一致：`mounted ? theme : 'system'`
- `DropdownMenuSub` / `SubTrigger` / `SubContent` 与设计 §4.2 一致
