# BelieveBoy 登录页重做实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将 `/login` 重做为具有鲜明品牌识别、清楚认证主操作并适配桌面与移动端的 BelieveBoy 入口，同时完整保留既有账号密码认证行为。

**Architecture:** 保持 `app/login/page.tsx` 路由和 Suspense 边界，围绕现有 `SignInCard` 的认证状态机构建新的页面结构与聚焦组件。先锁定认证、callback、错误处理和无障碍行为，再更换视觉构图；组件使用现有 term token 和 motion 体系，不引入新主题体系或改动 NextAuth 配置。

**Tech Stack:** Next.js 16 App Router、React 18、TypeScript、Tailwind CSS、NextAuth credentials、next-themes、Vitest/Testing Library、Playwright。

## Global Constraints

- 保持账号密码登录、NextAuth `signIn('credentials', ...)`、callback 安全限制、默认 `/dashboard` 跳转、全局导航 loading 生命周期和现有错误映射。
- 保持 `email` / `password` 稳定输入 id、`autoComplete` 语义、主题切换、密码显示/隐藏、键盘操作及焦点可见。
- 使用 `--term-*` 明暗双主题令牌；零圆角、零阴影、1px 边界，不新增第三套颜色或未经确认的营销内容。
- 登录页只展示有事实依据的信息；删除或改写静态伪实时 boot 行，如未确认的“会话已建立”“认证服务可达”或延迟数字。
- 动效必须尊重 `prefers-reduced-motion`，不隐藏首要内容、不延迟表单操作。
- 开始编码前阅读 `frontend/node_modules/next/dist/docs/` 中对应的已锁定 Next.js 16.2.4 App Router、客户端组件及 CSS 指南；本仓 `frontend/AGENTS.md` 明确提示版本/API 存在差异。
- 完成后按顺序执行 `pnpm lint` → `pnpm build` → `pnpm test`，并运行登录相关 Playwright 用例。

---

## Files and Responsibilities

- `frontend/app/login/page.tsx`：保留 Next Suspense 与路由入口，只有测试/结构证明有必要时才调整。
- `frontend/app/login/layout.tsx`：路由级页面元信息/布局；确认未接管的 root providers 和 theme provider。
- `frontend/components/login/index.tsx`：登录页面整体布局与品牌/认证区拓扑。
- `frontend/components/login/sign-in-card.tsx`：认证状态、callback 解析、submit、错误和导航 loading 生命周期；除测试驱动的必要改动外避免重写业务逻辑。
- `frontend/components/login/terminal-form-panel.tsx`：表单标签、输入、密码可见性、错误和提交反馈。
- `frontend/components/login/terminal-window.tsx`：当前 macOS terminal chrome；若新方向不再使用，删除或替换前先验证其余调用方。
- `frontend/components/login/boot-sequence.tsx`：当前静态启动序列；移除无事实依据的伪实时状态。若品牌区需要辅助信息，由 `login-brand-panel.tsx` 承担。
- `frontend/components/login/sign-in-card.test.tsx`：登录行为与结构契约。
- `frontend/tests/dashboard/home-mobile-blf621.spec.ts`：现有登录移动端触控与无横滚回归（定位并保留该断言）。
- 新建 `frontend/tests/login/login-responsive.spec.ts`：登录页 desktop/mobile、主题、无溢出与 reduced-motion 浏览器回归。

## Task 1: 锁定认证流程和 callback 安全行为

**Files:**
- Modify: `frontend/components/login/sign-in-card.test.tsx`
- Modify: `frontend/components/login/sign-in-card.tsx`
- Modify: `frontend/lib/auth/options.ts`
- Create: `frontend/lib/auth/network-auth-error.ts`
- Create: `frontend/lib/auth/network-auth-error.test.ts`
- Read: `frontend/lib/login-callback-url.ts`（当前代码中此 helper 仅构造 `/login?callbackUrl=...`，真实认证后安全跳转逻辑位于 `SignInCard`）

**Interfaces:**
- Consumes: 现有 `SignInCard` props-less client component 和 NextAuth credentials 接口。
- Produces: 覆盖默认跳转、站内 callback、外部 callback 安全回退、认证失败、网络失败、提交中和全局导航 loading 的行为测试；不改组件对外 API。

- [x] **Step 1: 检查当前登录单测和 callback helper**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：PASS。当前仓库未发现 `lib/login-callback-url.test.ts`；`buildLoginCallbackUrl` 只编码路径参数，与认证后的安全跳转不是同一逻辑。

- [x] **Step 2: 为 callback 安全边界补充测试**

补测试：同源 `callbackUrl` 保留 pathname/search/hash；绝对外站 URL 不被 router 导航；无效 URL 回退 `/dashboard`。对不支持的情况按 `sign-in-card.tsx` 中真实逻辑确定断言，不更改期望产品行为。

- [x] **Step 3: 为认证 loading 生命周期补充测试**

补测试：错误返回时不启动 navigation loading；认证成功后启动一次 navigation loading，再 `router.replace`；组件卸载时结束 pending navigation loading。用可控 Promise 验证提交态与结束时机。

- [x] **Step 4: 运行测试确认边界**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：PASS；新增安全边界断言落在真实认证跳转实现上并准确描述现有契约。若出现真实缺陷，先仅做最小行为修复并保持可审查的独立提交。

- [x] **Step 5: 提交认证行为护栏**

```bash
git add frontend/components/login/sign-in-card.test.tsx frontend/lib/login-callback-url.ts frontend/lib/login-callback-url.test.ts
git commit -m "test(登录页): 锁定认证与回跳行为"
```

仅暂存本次实际变更文件。

## Task 2: 重新构建品牌入口结构

**Files:**
- Modify: `frontend/components/login/index.tsx`
- Modify: `frontend/components/login/sign-in-card.tsx`
- Modify: `frontend/components/login/terminal-window.tsx` 或 Create: `frontend/components/login/login-brand-panel.tsx`
- Modify: `frontend/components/login/sign-in-card.test.tsx`

**Interfaces:**
- Consumes: Task 1 的认证状态行为；全局 ThemeProvider、GlobalLoadingProvider。
- Produces: `/login` 保持现有 Next route 和无 props 表单入口；品牌内容与认证表单形成清晰区域关系，不暴露新 auth provider。

- [x] **Step 1: 为新的信息层级写结构测试**

测试 `BelieveBoy` / `彼励扶跨境` 品牌识别、简洁且事实正确的产品定位、表单主标题、邮箱/密码标签与 primary submit 按钮；核心信息使用语义化标题/区域，屏幕阅读器顺序与视觉顺序一致。移除依赖 macOS 窗口标题、伪会话状态等旧结构的断言。

- [x] **Step 2: 运行测试确认新契约当前失败**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：新结构断言 FAIL，旧认证行为断言仍可运行；失败指向预期结构差异。

- [x] **Step 3: 用单一组件责任搭建品牌与表单区域**

在 `index.tsx` 承担页面画布与主布局；若品牌侧包含独立文案/装饰/辅助信息，则新增 `login-brand-panel.tsx` 负责它；`SignInCard` 继续拥有表单状态和提交，不把 auth hooks 提升到展示组件。桌面清楚呈现品牌与表单，窄屏单列且表单优先可见。仅用现存产品事实和 term tokens。

- [x] **Step 4: 跑登录组件测试确认重构未破坏行为**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：PASS，包括 Task 1 所有认证边界。

- [x] **Step 5: 提交登录页结构**

```bash
git add frontend/components/login/index.tsx frontend/components/login/sign-in-card.tsx frontend/components/login/terminal-window.tsx frontend/components/login/login-brand-panel.tsx frontend/components/login/sign-in-card.test.tsx
git commit -m "feat(登录页): 重构品牌入口与认证布局"
```

只暂存存在且实际修改的文件。

## Task 3: 统一表单状态和 V3 Terminal 视觉细节

**Files:**
- Modify: `frontend/components/login/terminal-form-panel.tsx`
- Modify: `frontend/components/login/terminal-window.tsx`（如保留）
- Modify: `frontend/components/login/boot-sequence.tsx`（或 Task 2 创建的可信品牌辅助内容组件）
- Modify: `frontend/components/login/sign-in-card.test.tsx`

**Interfaces:**
- Consumes: Task 2 的布局与现有 email/password/submitting/error/onSubmit props。
- Produces: 保持 `TerminalFormPanel` 当前 props 契约，完整呈现初始、提交、错误、密码显隐和键盘 focus 状态。

- [x] **Step 1: 写表单状态和无障碍契约测试**

增加/更新测试：输入有可见关联 label 和正确 autocomplete；密码切换按钮有准确 accessible name；错误在 `aria-live` 区域出现；提交按钮 loading 时禁用表单输入；focus-visible 状态可见；不再呈现未经证实的延迟/认证健康状态。

- [x] **Step 2: 运行测试确认待改断言失败**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：FAIL 项仅对应尚未满足的可访问/视觉契约。

- [x] **Step 3: 实现符合 V3 的表单呈现**

使用 `rounded-none border-term-border`、`bg-term-panel/bg-term-raised/bg-term-bg` 和语义色 token；避免 shadow 与圆角。成排行控件遵循终端高度阶梯及触控尺寸约束。错误文案保留原有含义并与表单关联；静态品牌辅助文案不得冒充实时探测。

- [x] **Step 4: 运行组件测试**

运行：`cd frontend && pnpm vitest run components/login/sign-in-card.test.tsx`

预期：PASS，登录行为和主题切换相关测试均通过。

- [x] **Step 5: 提交表单细节**

```bash
git add frontend/components/login
git commit -m "fix(登录页): 收口表单状态与终端样式"
```

## Task 4: 添加登录页响应式、主题与动效回归

**Files:**
- Create: `frontend/tests/login/login-responsive.spec.ts`
- Modify: `frontend/tests/dashboard/home-mobile-blf621.spec.ts`（只在选择器/断言需更新时）
- Read: `frontend/tests/setup/global-setup.ts`
- Read: `frontend/components/motion/MotionFade.tsx`
- Read: `frontend/components/motion/use-prefers-reduced-motion.ts` 或当前实际 hook 路径

**Interfaces:**
- Consumes: Tasks 1–3 的 `/login` UI 和真实 NextAuth 路由行为。
- Produces: 登录在桌面/移动视口、明暗主题及 reduced-motion 偏好下可用的浏览器回归。

- [x] **Step 1: 检查已有 mobile-blf621 登录覆盖与 Playwright 配置**

运行：`rg -n "登录页|/login|触摸目标|横滚" frontend/tests/dashboard/home-mobile-blf621.spec.ts frontend/playwright.config.ts`

预期：识别已有 fixture 和登录测试，避免重复或冲突配置。

- [x] **Step 2: 写 Playwright 测试**

新增登录场景，清理 fixture session 后访问 `/login`；分别设 390×844 和 1440×900；断言主标题、表单、提交按钮可见、body 无横向溢出；主题测试切换后检查关键区域仍有 term 颜色类/可见性；reduced-motion context 下断言品牌与表单仍立即可见。不得使用生产账号或真实后端账号。

- [x] **Step 3: 运行 Playwright 确认新测试能够捕获布局问题**

运行：`cd frontend && pnpm test:ui -- tests/login/login-responsive.spec.ts`

预期：若依赖 webServer，Playwright 启动配置的本地 server；FAIL 只应是尚未完成的目标布局，不应重写全局 setup。

- [x] **Step 4: 修复响应式溢出与 reduced-motion 缺口**

在登录组件自身修复列宽、顺序、滚动和动效退化；保留 root `body` 行为与 dashboard shell。减少动态偏好下不播放非必要入场运动，但表单和错误文本仍立即显示。

- [x] **Step 5: 运行登录与既有移动回归**

运行：`cd frontend && pnpm test:ui -- tests/login/login-responsive.spec.ts tests/dashboard/home-mobile-blf621.spec.ts`

预期：PASS；若当前 home mobile spec 要求本地 fixture，沿用 `playwright.config.ts` 的自包含 spec 配置，不新增真实登录依赖。

- [x] **Step 6: 提交响应式测试**

```bash
git add frontend/tests/login/login-responsive.spec.ts frontend/tests/dashboard/home-mobile-blf621.spec.ts
git commit -m "test(登录页): 覆盖响应式主题与减少动态"
```

## Task 5: 浏览器批量检查和完整验证

**Files:**
- Read/Modify: Task 4 的登录测试
- Read: `frontend/docs/design-spec.md`
- Read: `frontend/docs/motion-system.md`

**Interfaces:**
- Consumes: Tasks 1–4 的页面实现和验证用例。
- Produces: 登录页首轮交付验证；认证仍通过原 NextAuth handler，范围不扩展到新认证方式。

- [x] **Step 1: 完整跑前端必需检查**

运行：`cd frontend && pnpm lint && pnpm build && pnpm test`

结果：`pnpm lint` 退出码 0（0 errors，27 条既有 warning）；`pnpm build` 成功（Next.js 16.2.4）；全量 `pnpm test` 在本地 runner 中分别以默认 pool、8/16 worker 和 2 worker 尝试，均在工具时限内未能结束。登录及 Auth.js 网络错误单测已通过 21/21。

- [x] **Step 2: 跑 Playwright 登录回归**

运行：`cd frontend && PLAYWRIGHT_PORT=3224 pnpm exec playwright test tests/login/login-responsive.spec.ts --project=chromium` 以及 `pnpm exec playwright test tests/dashboard/home-mobile-blf621.spec.ts --project=mobile -g '登录页'`

结果：登录响应式/主题/reduced-motion/方形键盘焦点/对比度 6/6 通过；BLF-621 登录触控/无横滚 1/1 通过。全文件包含另外 8 个旧后台页面用例，不纳入登录验证范围。

- [x] **Step 3: 批量检查桌面/移动、light/dark、正常/减少动态**

已一次捕获并检查 1440px、390px 两个视口与 light/dark 两主题；桌面品牌主视觉、移动首屏表单、焦点/表单状态、loading 和错误语义均检查。根据检查与代码审查结果修复移动端首屏、占位对比度、按钮对比度和暗色阴影；收尾验证登录响应式、主题、减少动态、焦点形状、语义顺序和实际对比度浏览器回归 6/6 通过。

- [x] **Step 4: 运行 Impeccable detector 一次**

运行：`/Users/damon/.config/opencode/skills/impeccable/scripts/impeccable detect --json frontend/components/login frontend/app/login`

结果：检测输出 `[]`，没有机械设计问题。此轮仅执行一次。

- [x] **Step 5: 提交最终登录页实现**

```bash
git add frontend/app/login frontend/components/login frontend/tests/login frontend/tests/dashboard/home-mobile-blf621.spec.ts
git commit -m "feat(登录页): 完成品牌入口重做"
```

仅暂存此计划实际变更文件；若前述任务提交已完整包含代码，本步骤提交最终截图/必要文档收尾，不创建空提交。

## Definition of Done

- `/login` 的品牌入口与认证主操作层级清楚，桌面只有一个品牌 H1（表单标题 H2），移动只有一个屏幕阅读器品牌 H1（可见表单标题 H2）；桌面和移动可用，明暗主题均可读。
- 凭据认证、站内 callback、安全回退、认证网络错误 code、提交禁用和导航 loading 行为通过自动化测试。
- 移除未确认的静态伪实时 boot 状态或延迟数据；没有虚构客户/结果/服务状态。
- 减少动态偏好下页面核心内容立即可见且功能完整。
- 登录相关 Vitest 21/21、登录 Playwright 6/6、BLF-621 登录回归 1/1、lint 0 errors、production build 通过；Impeccable detector 返回 `[]`；桌面/移动 light/dark 截图已复核。
- 全量 Vitest 在本轮不同 worker/pool 配置下均超过 runner 时限，尚未取得完整 suite 的结束报告；后续 CI 或专用长时 runner 应继续跑完整 `pnpm test`。
