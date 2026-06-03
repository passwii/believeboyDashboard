# Theme Toggle 迁移到 Sidebar User 模块 — 设计

**日期**：2026-06-03
**作者**：Claude (brainstorming 流程产出)
**状态**：待用户审查

---

## 1. 目标

将当前 Dashboard 右上角（桌面 + 移动端折叠工具栏）的 Dark/Light Mode 切换控件，迁移到 Sidebar 底部 `NavUser` 头像下拉菜单中，**保留三选项**（浅色 / 深色 / 跟随系统）。

不在 `ThemeToggle` 的可访问性/样式上做改动，仅做位置迁移。

## 2. 范围

### 改动文件（2 个）

| 文件 | 变更 |
|------|------|
| `frontend/components/dashboard/nav-user.tsx` | 在 dropdown 中加入"外观"子菜单 |
| `frontend/app/dashboard/layout.tsx` | 移除桌面 + 移动端两处 `<ThemeToggle />`，删除其 `import` |

### 不动文件

- `frontend/components/theme-toggle.tsx` — **保留**，不删除。理由：(a) 未来其他场景可能复用；(b) 不引入无关重构。
- `frontend/components/theme-provider.tsx` — 主题 Provider 不动。
- `frontend/app/dashboard/change-password/page.tsx` — 与本任务无关。

## 3. NavUser Dropdown 新结构

```
┌─────────────────────────────┐
│ [头像]  用户名              │
│         user@email · 运营   │
├─────────────────────────────┤
│ ☀️  外观                  ▸ │   ← 新增 DropdownMenuSub
│      ├─ ☀️ 浅色          ✓ │   ← DropdownMenuRadioItem
│      ├─ 🌙 深色             │
│      └─ 🖥️ 跟随系统        │
├─────────────────────────────┤  ← DropdownMenuSeparator
│ 🔑  修改密码                │
├─────────────────────────────┤  ← DropdownMenuSeparator
│ 🚪  退出登录                │
└─────────────────────────────┘
```

- 三段式分组：外观 / 账号 / 离开，每段之间用 `<DropdownMenuSeparator />` 隔开
- 子菜单 trigger 文本"外观"，图标 `SunMedium`
- 子菜单三选项图标：`SunMedium` / `Moon` / `Monitor`
- 当前选中项右侧显示 `<Check />`

## 4. 关键实现细节

### 4.1 主题状态来源

完全复用 `ThemeToggle` 的 hooks 调用方式：

```tsx
import { useTheme } from 'next-themes'
const { theme, resolvedTheme, setTheme } = useTheme()
const [mounted, setMounted] = useState(false)
useEffect(() => setMounted(true), [])
const currentTheme = mounted ? theme : 'system'
```

`mounted` 用于避免 SSR/CSR hydration mismatch（首次渲染时 `theme` 为 `undefined`）。

### 4.2 子菜单实现

使用 shadcn/ui 包装的 Radix `DropdownMenuSub`：

```tsx
<DropdownMenuSub>
  <DropdownMenuSubTrigger>
    <SunMedium className="..." />
    <span>外观</span>
  </DropdownMenuSubTrigger>
  <DropdownMenuSubContent>
    <DropdownMenuItem onClick={() => setTheme('light')}>
      <SunMedium className="..." />
      浅色
      {currentTheme === 'light' ? <Check className="..." /> : null}
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => setTheme('dark')}>
      <Moon className="..." />
      深色
      {currentTheme === 'dark' ? <Check className="..." /> : null}
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => setTheme('system')}>
      <Monitor className="..." />
      跟随系统
      {currentTheme === 'system' ? <Check className="..." /> : null}
    </DropdownMenuItem>
  </DropdownMenuSubContent>
</DropdownMenuSub>
```

`DropdownMenuSub` / `DropdownMenuSubTrigger` / `DropdownMenuSubContent` 已在 `frontend/components/ui/dropdown-menu.tsx` 中导出（基于 `@radix-ui/react-dropdown-menu` 包装，shadcn/ui 标准），可直接 import 使用。

### 4.3 layout.tsx 删除项

`frontend/app/dashboard/layout.tsx`：
- 删除第 21 行：`import { ThemeToggle } from '@/components/theme-toggle'`
- 删除第 302 行：`<ThemeToggle />`（桌面工具栏）
- 删除第 348 行：`<ThemeToggle />`（移动端折叠工具栏）
- 顶部其他按钮（NotificationBell / RecentPagesDropdown / BookOpen 帮助按钮）保持不变

## 5. 副作用 & 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 切主题多一次点击 | 低 | 用户明确接受此权衡 |
| 移动端 `side='bottom'` 时子菜单行为 | 中 | Radix `DropdownMenuSub` 官方支持；用现有 `cn` 工具保持样式一致 |
| `ThemeToggle` 文件废弃 | 低 | 保留不删；如有 lint 规则（unused）需保留文件但不影响构建 |

## 6. 测试

按 `CLAUDE.md` 规则两轮：

### 6.1 技术测试

```bash
cd frontend && pnpm build
```

构建失败立即修复。

### 6.2 业务测试清单（用户手动跑）

| # | 测试项 | 期望 |
|---|--------|------|
| 1 | 桌面端打开 Sidebar 底部头像 dropdown | 看到"外观"子菜单 trigger（带 SunMedium 图标） |
| 2 | 点击"外观" | 弹出右侧子菜单，含三选项：浅色/深色/跟随系统 |
| 3 | 当前主题选中项 | 右侧出现 ✓ |
| 4 | 切换"深色" | 整页立即变深色；刷新页面后保持深色 |
| 5 | 切换"浅色" | 整页立即变浅色；刷新后保持 |
| 6 | 切换"跟随系统" | 跟随系统当前 dark/light 偏好 |
| 7 | 桌面顶栏 | 不再有 ThemeToggle 图标 |
| 8 | 移动端折叠工具栏 | 展开后不再有 ThemeToggle 图标 |
| 9 | 键盘可访问性 | Tab 焦点可进入"外观"，→ 进入子菜单，↑↓ 选择，Enter 切换 |
| 10 | dropdown 关闭 | 切换主题后 dropdown 自动关闭（Radix 默认行为） |

## 7. 验收标准

- [ ] `pnpm build` 通过
- [ ] 业务测试清单 10 项全部 ✅
- [ ] `ThemeToggle` 组件未删除，`git diff` 中只显示 2 个文件变更
- [ ] 用户无新增反馈意见

## 8. 不在范围内

- 不改 `next-themes` 配置
- 不改主题色板 / token
- 不重构 `ThemeToggle` 内部实现
- 不新增"账号设置"等其他页面（本任务只动 nav-user dropdown）
