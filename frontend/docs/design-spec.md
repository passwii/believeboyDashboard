# 设计规范（Design Spec）

> **适用版本：** v1
> **适用对象：** 在 `frontend/` 下新增 / 修改 UI 的工程师
> **目标：** 记录"刻意为之、不走 token"的设计决策，避免后续被误判为 bug 或误改。

---

## 1. 硬编码色值例外清单（Deliberate Exceptions）

以下区域**刻意**使用硬编码色值 / 非标准 token，**不是 bug**。修改前请先阅读对应条目；若需要改动视觉，请先与本条目对齐或更新本文件。

### 1.1 AI Chat 玻璃岛（`components/chat/*`）

- **范围**：`components/chat/ai-chat-window.tsx`、`conversation-sidebar.tsx`、`model-selector.tsx`、`token-footer.tsx` 等。
- **现状**：内部使用 `bg-white/[0.06]`、`border-white/[0.08]`、`text-[#8a8a8f]` / `text-[#5a5a5f]` 等**硬编码灰阶 + 白色透明度**，不走 CSS token。
- **决策依据**：聊天区是**刻意设计的"暗色玻璃岛"**——独立于全站 light/dark 双主题，恒为深色玻璃质感（Raycast 风格）。页面 `app/dashboard/ai/chat/page.tsx` 通过 `useTheme` 在 mount/unmount 强制临时 `dark`，离开时还原，不污染其他页面。
- **结论**：**保持现状**，不迁移到 token。若未来要统一，需先改页面级主题策略（整页恒暗 vs 跟随主题），再收口色值。

### 1.2 文档渲染白底（`page-render` / `page-renderer`）

- **范围**：`app/dashboard/tools/page-render/page-render-client.tsx`（HTML 预览 iframe）、`app/p/[id]/page-renderer.tsx`（公开页 HTML 渲染 iframe）。
- **现状**：HTML 预览 iframe 使用 `bg-white`；公开页 Markdown 分支使用 `bg-background` + `dark:prose-invert`。
- **决策依据**：
  - HTML 分支渲染的是**用户上传的独立 HTML 文档**（`srcDoc` + `sandbox`），文档自带背景；iframe 的 `bg-white` 只是"纸张画布"底色，跟随主题会让文档观感失真。
  - Markdown 分支走 token（`bg-background` + `dark:prose-invert`），已适配暗黑。
- **结论**：**保持现状**。HTML 画布白底是刻意设计，Markdown 已 token 化。全仓 grep `bg-white` 时此两处为白底渲染页例外。

### 1.3 数字大屏（`app/dashboard/system/digital-display/page.tsx`）

- **现状**：页面在 mount 时强制 `document.documentElement.classList.add('dark')` 并请求全屏，**恒为暗色展示页**（无 light 态）。
- **注意**：自 BLF-494 起，大屏卡片已从 `sidebar-foreground` 自制配方迁移到标准 surface token（`--surface-panel` / `--surface-subtle` + `--border`），与全站一致。

---

## 2. Token 使用红线

1. **业务页面禁止裸用 `bg-white` / `bg-slate-100` / `bg-gray-50` / `text-gray-700` 等浅色硬编码**（无 `dark:` 变体时）。统一用 `bg-[hsl(var(--surface-*))]` / `bg-[hsl(var(--muted))]` 等 token。
2. **表格粘性表头**：单元格背景必须用不透明 token（推荐 `bg-[hsl(var(--surface-subtle))]`），否则滚动时暗黑模式会出现浅色带。
3. 状态色用 `components/ui/table-presets.tsx` 的 `statusPillClass`（映射 `--data-*` token，自动适配 dark），或 `Badge` 内置 variant（`success` / `warning` / `info` / `destructive`，自带 dark 变体）。
4. 修改 token 需双侧同步：`globals.css` ↔ `lib/motion/tokens.ts`（见 `motion-system.md` §2.3）。
