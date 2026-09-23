# 前端 Terminal 共享组件首轮盘点

> **状态：** 首轮盘点完成。**范围：** 高复用共享控件的现状契约核对；只有可复现偏差才改生产实现。

## 设计边界

- `frontend/docs/design-spec.md` 登记的 V3 Terminal 规则适用于 term surfaces。
- `frontend/components/ui/tabs.tsx` 的 default variant 与 AI Chat V2 是独立设计表面，保留既有圆角/渐变/投影。本轮只核对 `variant="term"`，不把 Terminal 规则套到 default Tabs。
- `frontend/components/ui/table.tsx` 的 `STICKY_TOP_*` 使用单像素 inset 阴影作为边界线表达；这是 `frontend/docs/table-spec.md` 的既有约定，不属于卡片投影阴影，不作全局清理。
- 各组件的行为、业务数据含义与公共 API 保持不变。

## 基线盘点

| 组件 | 文件与验证 | 检查结果 | 首轮处理 |
|---|---|---|---|
| Button | `components/ui/button.tsx`、`button.test.tsx` | 圆角/尺寸档、disabled、u-press/u-focus/u-interactive 及有意的暗色 `u-btn` 变体均有契约 | 暂无可复现的共享组件缺口；不改 API |
| Input | `components/ui/input.tsx`、`input.test.tsx` | rounded-none、term 背景/边界、mono、`aria-invalid`、focus glow、尺寸档及 shadow-none 均有测试 | 登录页的专用输入高度/placeholder contrast 已局部完成；基础 Input 暂不改 |
| Tabs | `components/ui/tabs.tsx`、`tabs.test.tsx` | term variant 有 h-10/直角/选中态指示条测试；default variant 有意保持 V2 外观 | term 行为保持；default 外观不纳入 Terminal 重写 |
| Table | `components/ui/table.tsx`、`table.test.tsx` | sticky 背景使用实体 term 色；边界用 inset 1px separator token；移动端 max-content 横滑有契约 | 按页面使用场景继续验证，不改全局表格 API 或 inset 分隔线 |
| Terminal controls | `components/terminal/term-controls.tsx`、`term-controls.test.tsx` | TERM_BUTTON/INPUT/SELECT_NATIVE 尺寸阶梯、直角与 term token；TermTabBar selected ARIA 有基线 | 本轮基线保持，不新增重复的 term-shared 副本 |
| Terminal shell | Rail/SubNav/Header/Inspector/Footer + 同目录测试 | 56px/36px/顶部基准带常量已有引用；Header 状态和 Footer accessible name 已补回归；Rail 与 Footer Lucide stroke 收至 1.75 | 保留本轮明确修复；不为形成更大视觉改造而修改其他既有交互 |
| Dialog/Sheet | `components/ui/dialog.test.tsx`、`sheet.test.tsx` | `rounded-none`、`shadow-none`、term 背景/边界与 dark floating-glass 分离规则均有测试；Dialog title 实例提供标题 | 当前无新缺口；不改浮层公共 API |
| Empty states | `components/ui/empty-state.tsx` | 已使用 term-faint 图标、term-muted 文案与 term-raised 虚线容器 | 未发现会阻塞任务的复现差异；页面状态场景由后续页面批次覆盖 |

## 验证证据

- 外壳六组件基线：
  `pnpm exec vitest run components/terminal/terminal-rail.test.tsx components/terminal/terminal-subnav.test.tsx components/terminal/terminal-header.test.tsx components/terminal/terminal-inspector.test.tsx components/terminal/terminal-footer.test.tsx components/terminal/use-terminal-layout.test.ts --pool=threads --maxWorkers=1 --reporter=dot`
  最终基线 **6 files / 57 tests passed**。
- 共享 Button/Input/Tabs/Table/Term Controls：
  `pnpm exec vitest run components/ui/button.test.tsx components/ui/input.test.tsx components/ui/tabs.test.tsx components/ui/table.test.tsx components/terminal/term-controls.test.tsx --pool=threads --maxWorkers=1 --reporter=dot`
  **5 files / 34 tests passed**。
- Dialog/Sheet token 与标题基线：
  `pnpm exec vitest run components/ui/dialog.test.tsx components/ui/sheet.test.tsx --pool=threads --maxWorkers=1 --reporter=dot`
  **2 files / 4 tests passed**。
- Footer 状态语义、Header 尺寸/pressed 状态与 L1/Footer stroke 缺口均先通过失败测试复现，再以最小生产代码修正；针对 Header/Footer/Rail 的最后一组 targeted tests **44 tests passed**。

## 后续组件修正准入

目前首轮其余 Button/Input/term Tabs/Table/Dialog/Sheet 缺口没有经验证的 bug，因此不安排无目标的共享组件重写。daily-analysis / order-info 两个页面样板测试若能归因到共享组件，按具体调用方新增单一失败断言，再修共享源头并复核同类调用；default Tabs、dashboard-v2 与表格 separator 的既有例外继续保留。
