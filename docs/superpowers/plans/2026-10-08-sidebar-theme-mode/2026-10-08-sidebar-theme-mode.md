# 侧边栏主题模式选择实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面侧栏和移动导航抽屉提供浅色、深色、跟随系统三态主题选择，并加上克制、无障碍友好的切换反馈。

**Architecture:** 新增 `ThemeModePicker` 作为唯一的主题选择和切换动效边界，使用 `next-themes` 保存和解析主题；桌面 rail 以 hover/click 打开，移动抽屉以 click 打开。全局 CSS 只在一次用户主动选择后短暂启用颜色过渡，初始 hydration 与系统自动变化不启动该状态。

**Tech Stack:** Next.js、React、next-themes、Radix DropdownMenu、Tailwind CSS、Vitest、Testing Library。

## 全局约束

- 主题 preference 值使用 `light`、`dark`、`system`，不增加第二份持久化状态。
- 桌面 hover 只展开菜单，不因 hover 某选项而切换；选项仍通过激活操作确认。
- 减少动态效果设置生效；页面过渡不改变布局、尺寸或滚动位置。
- 先写测试并观察预期失败，再写最小实现；前端按 T2 运行目标 Vitest 与 `pnpm lint`。
- 所有 Git 标题 / PR 标题和分节抬头均使用中文；不创建数据库迁移或触碰后端。

---

### 任务 1：建立共享主题选择器及行为测试

**文件：**
- 新增：`frontend/components/terminal/theme-mode-picker.tsx`
- 新增：`frontend/components/terminal/theme-mode-picker.test.tsx`
- 修改：`frontend/components/ui/dropdown-menu.tsx`

**接口：**
- `ThemeModePicker({ placement }: { placement: 'rail' | 'mobile' })`
- 消费 `useTheme()` 的 `theme`、`resolvedTheme`、`setTheme`。
- `placement='rail'` 提供图标按钮和向右菜单；`placement='mobile'` 提供带“外观”文字的按钮和向上菜单。
- 菜单用 `DropdownMenuRadioGroup` 呈现三个模式；触发器图标由偏好值决定（Sun / Moon / Monitor）。
- 鼠标进入桌面触发器后短暂延时展开；触发器与菜单之间使用一个可取消的短延时关闭计时器。非鼠标指针不触发 hover 行为。
- `setTheme` 只在选择模式时调用；同一个模式不重复启动主题过渡。

- [x] 写测试：桌面触发器的 `pointerenter` 打开菜单；菜单包含浅色、深色、自动三项，当前偏好被标记。
- [x] 运行 `cd frontend && pnpm exec vitest run components/terminal/theme-mode-picker.test.tsx`，确认因组件不存在 / 交互未实现而失败。
- [x] 写测试：离开触发器后进入菜单可取消关闭；离开菜单后延迟关闭；选择三项分别调用 `setTheme('light'|'dark'|'system')`。
- [x] 再运行同一 Vitest 命令，确认新增行为测试失败在预期断言，而非测试环境错误。
- [x] 实现共享选择器；关闭计时器在重入、选中、卸载时清理；当前偏好缺失时按 `system` 呈现。
- [x] 重跑目标 Vitest，确认行为测试通过。
- [x] 扩展 DropdownMenuContent 的 `onOpenAutoFocus` 透传，并区分鼠标与键盘焦点：键盘焦点位于按钮时 hover 打开可继续操作，鼠标 hover 不抢占其他焦点（21 项组件测试通过）。

### 任务 2：接入桌面侧栏与移动抽屉

**文件：**
- 修改：`frontend/components/terminal/terminal-rail.tsx`
- 修改：`frontend/components/terminal/terminal-shell.tsx`
- 修改：`frontend/components/terminal/terminal-rail.test.tsx`
- 测试：`frontend/components/terminal/theme-mode-picker.test.tsx`

- [x] 将 rail 原来的二态主题按钮替换为 `<ThemeModePicker placement="rail" />`，保留 rail 尺寸与底部对齐。
- [x] 在移动导航 Sheet 内容底部新增分隔区域与 `<ThemeModePicker placement="mobile" />`。
- [x] 更新 rail 测试，使其验证共享选择器、可访问名称和图标尺寸；保留 Logo 与轨道图标常量测试。
- [x] 添加移动入口测试，验证触发器可访问名称、点击展开三态菜单、选择后调用主题设置。
- [x] 运行 `cd frontend && pnpm exec vitest run components/terminal/theme-mode-picker.test.tsx components/terminal/terminal-rail.test.tsx`，确认相关组件测试通过。

### 任务 3：加入主题切换反馈并校验无障碍偏好

**文件：**
- 修改：`frontend/app/layout.tsx`
- 修改：`frontend/app/globals.css`
- 测试：`frontend/components/terminal/theme-mode-picker.test.tsx`

- [x] 写测试：主动选择模式后 `document.documentElement` 得到短暂的主题过渡标记，切换当前模式时不触发 `setTheme` 或过渡。
- [x] 运行目标 Vitest，确认过渡状态断言失败。
- [x] 从 RootLayout 移除 `disableTransitionOnChange`，由选择器在用户提交不同模式前设置根过渡标记，并在约 240ms 后清除；图标状态计时器在状态变化时清理。
- [x] 增加未分层全局过渡 CSS：限制在颜色属性、220ms；避免 Tailwind utilities 覆盖过渡约束；增加图标淡入和轻微旋转 keyframe；`prefers-reduced-motion: reduce` 下禁用图标 keyframe并将页面过渡降至即时。
- [x] 重跑目标 Vitest，确认主动选择触发过渡且已有测试通过。

### 任务 4：回归验证与自审

**文件：**
- 检查：上述全部变更文件

- [x] 运行 `cd frontend && pnpm exec vitest run components/terminal/theme-mode-picker.test.tsx components/terminal/terminal-rail.test.tsx components/ui/dropdown-menu.test.tsx`（21 项通过）。
- [x] 运行 `cd frontend && pnpm lint`（0 错误；仓库现有 27 条 warning）。
- [x] 检查 `git diff --check`、最终 diff 与 `git status --short`；确认无意外文件、无主题初始加载动画、无过渡计时器泄漏；确认本次触及文件无 TypeScript 错误（仓库其他既有错误不在本任务范围）。
- [x] 按验收标准逐项核对 hover 延时、键盘 / Escape、触屏入口、三态选中和减少动态效果。
