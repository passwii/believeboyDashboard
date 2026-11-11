# Modern Web Guidance 本地部署与前端审视调研

> 调研日期：2026-11-11
> 调研对象：`GoogleChrome/modern-web-guidance`，npm `modern-web-guidance@1.0.0`
> 调研环境：macOS，Node v26.0.0，npm 11.12.1，Codex CLI 0.167.1
> 审视范围：`frontend/`（Next.js 16.2.4 + React 18.3.1 + Radix/shadcn + Tailwind 3.4）

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 能否在用户本地部署（安装）？ | **可以。** 不需要服务端、账号或 API key；已在本机隔离目录验证 Codex 插件和 `npx skills` 两条安装路径。 |
| 安装后做“A 点调用”是否有用？ | **有，但先要定义“A 点”。** 如果指“在某个具体前端改动点调用”，它适合在写 UI 前查指南、取代码模式；如果指“对整个前端做一次性体检”，它只能做静态启发式扫描，不是完整审计。 |
| 能否更好地审视当前前端？ | **能发现问题，但不能替代人工判断。** 本次扫描出 14 条 / 4 类，人工复核后 3 条是明确误报、11 条可评估；其中 6 条 IME 输入问题和 1 条 `field-sizing` 最值得做试点。 |
| 能否更好地集成现代组件？ | **能给出现代实现方案、Baseline 数据和降级策略，但它不是组件库，也不会自动改代码。** 原生 `<dialog>` / Popover 可按场景采用；Anchor Positioning 目前只有 Safari 27 支持，不适合现在替换 Radix/Floating UI。 |
| 建议 | 团队 Codex 优先装插件；把“UI 改动前先 `search` / `retrieve`”写进前端工作流；`legacy-scan` 只做周期性体检，不接 CI 阻断门禁。 |

一句话：**它适合当“前端实现前的规范查询器 + 季度体检工具”，不适合当“自动重构器”或“组件库”。**

## 1. 调研对象事实

- 仓库：<https://github.com/GoogleChrome/modern-web-guidance>，描述为 “Keep your coding agent up to date with the latest web best practices”。
- 维护方：Google Chrome、Microsoft Edge、Mozilla Firefox、MDN 团队与社区共同维护。
- 许可证：代码 Apache-2.0；`guides/` 文档 CC-BY-4.0。
- 分发形式：skill / plugin 清单（`.codex-plugin/`、`.claude-plugin/`、`plugin.json` 等），CLI 入口是 `skills/modern-web-guidance/modern-web.mjs`。
- 运行要求：`package.json` 要求 Node >= 22；本机 Node v26.0.0 可直接运行。
- 内容规模：README 声称覆盖 250 个现代 Web 特性；`legacy-scan` 只使用其中 33 条确定性规则（约 20% 语料），其余指南需要 agent 主动 `search` / `retrieve`。
- 是否有常驻服务：**没有。** 它只安装 skill 文件并提供 CLI；检索使用本地 embedding + BM25，不需要 API key。`npx` 首次运行需要联网下载 npm 包，之后检索本身在本地完成。
- 遥测：默认开启匿名使用事件（安装次数、agent 名称、检索的 guide ID、搜索 query 等）；设置 `DISABLE_TELEMETRY=1` 可完全关闭。

## 2. 本地安装验证

### 2.1 Codex 原生插件（推荐给本团队）

在本机用隔离的 `CODEX_HOME` 验证通过：

```bash
codex plugin marketplace add GoogleChrome/modern-web-guidance
codex plugin add modern-web-guidance@googlechrome
codex plugin list
```

实测结果：

- marketplace 名称：`googlechrome`
- 安装路径：`$CODEX_HOME/plugins/cache/googlechrome/modern-web-guidance/1.0.0`
- 版本：`1.0.0`，安装后 `installed: true`、`enabled: true`
- 体积：约 4.9 MB
- 安装过程未要求额外登录或密钥

卸载：

```bash
codex plugin remove modern-web-guidance@googlechrome
```

> 说明：以上验证使用了临时 `CODEX_HOME=/tmp/mwg-codex-home`，没有改动用户真实 `~/.codex` 配置。

### 2.2 `npx modern-web-guidance install` / Vercel Skills CLI

交互式安装：

```bash
npx modern-web-guidance@latest install
```

脚本 / 非交互等价命令（已实测）：

```bash
npx -y skills add GoogleChrome/modern-web-guidance \
  -g -a codex -s modern-web-guidance -y --copy
```

实测结果：

- 安装路径：`~/.agents/skills/modern-web-guidance`
- 体积：约 2.3 MB（`SKILL.md` + `guides/`）
- 内容：不含常驻进程；CLI 仍通过 `npx modern-web-guidance@latest ...` 调用
- 安全评估面板显示：Gen `Safe`、Socket `1 alert`、Snyk `Low Risk`

**项目级安装的注意点（已实测）：** 去掉 `-g` 会在仓库内创建 `.agents/skills/modern-web-guidance`，并把根目录 `skills-lock.json` 从 version 1 改为 version 2；现有 GSAP skills 的 `computedHash` 会被清空，并新增 `modern-web-guidance` 条目。`.agents/skills` 被 `.gitignore` 的 `skills/` 规则忽略，但 `skills-lock.json` 的变更会进入工作区。**本仓库建议用全局安装或 Codex 插件，避免顺手改坏现有 skills lock。**

### 2.3 不安装直接试用

```bash
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest search "animate a dialog modal backdrop"
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest retrieve "animate-to-from-top-layer"
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest legacy-scan frontend
```

本机实测耗时（已缓存 npm 包后）：

- `search`：约 2–3 秒
- `retrieve`：约 2–3 秒；单次多 guide 合并输出 23.9 KB / 399 行时，CLI 会自动落盘到临时文件，提示 agent 用文件读取工具读全文
- `legacy-scan frontend`：约 8.7 秒

### 2.4 更新与卸载

```bash
# 通过 install 安装的 skill
npx modern-web-guidance@latest update
npx modern-web-guidance@latest uninstall

# Codex 插件
codex plugin marketplace upgrade googlechrome
codex plugin remove modern-web-guidance@googlechrome
```

## 3. “A 点调用”实测

### 3.1 “A 点”的含义

Issue 没有指定具体页面、路由或调用位置。本文按以下三种可执行含义验证：

1. **实现点调用**：在改动某个组件 / 页面前，agent 先 `search` 能力，再 `retrieve` 对应 guide，按指南写代码。
2. **存量体检**：对一个目录跑 `legacy-scan`，得到“可能过时”的清单，再由人 / agent 逐条复核。
3. **组件选型**：在决定用原生 API 还是现有 Radix 组件前，查对应 guide 的 Baseline、降级策略和可访问性要求。

如果用户指的是某个具体页面（例如某个 dashboard 路由），需要补充该页面 / 路由；本次先用仓库级扫描 + 代表性组件验证调用链。

### 3.2 调用链与输出质量

以“弹窗动画”为例：

```bash
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest search "animate a dialog modal backdrop"
# 返回 animate-to-from-top-layer、light-dismiss-a-dialog、dialog、navigation-drawer 等 id

DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest retrieve "animate-to-intrinsic-sizes"
```

输出不是泛泛而谈，而是包含：

- 实现步骤（例如 `interpolate-size: allow-keywords` + `block-size` transition）
- 可复制的 HTML/CSS/JS 示例
- 强制项（如 `prefers-reduced-motion`、`aria-expanded`、`hidden` 同步）
- Baseline 与浏览器支持（例如 `interpolate-size` 仅 Chrome 129+ / Edge 129+，Firefox 和 Safari 不支持）
- 降级策略与 gotcha

这类内容对 agent 写实现代码确实有帮助；但示例是 vanilla HTML/CSS/JS，落到 React / Next.js / Radix 时需要自行适配。

### 3.3 当前前端扫描结果

命令：

```bash
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest legacy-scan frontend --json
```

结果：**14 条 findings，4 个 guide，扫描了 33 个 guide 的确定性规则，跳过 429 个文档 / 测试文件。**

| Guide | 条数 | 人工复核结论 |
| --- | ---: | --- |
| `ime-safe-enter-submit` | 10 | 7 条真实（其中 1 条低影响），3 条是 number input 误报 |
| `autofill-sign-up-form` | 2 | 语义不完全是“注册”，但补 `autocomplete="new-password"` 低风险、可做 |
| `form-fields-automatically-fit-contents` | 1 | 真实；`field-sizing` 可作为渐进增强 |
| `animate-to-intrinsic-sizes` | 1 | 真实但优先级低；`interpolate-size` 只有 Chrome/Edge 支持 |

### 3.4 逐项复核

#### IME 安全（10 条）

扫描认为以下 `keydown` Enter 处理器没有检查 `event.isComposing` / `keyCode === 229`：

| 位置 | 输入类型 | 复核 |
| --- | --- | --- |
| `frontend/components/chat/chat-input.tsx:96` | 聊天 textarea，中文输入高频 | **真实，优先级高**。中文输入法确认候选词时按 Enter 会直接发送未完成文本。 |
| `frontend/components/chat/conversation-sidebar.tsx:252` | 会话重命名 input，中文标题 | **真实，优先级中**。 |
| `frontend/components/crm/crm-category-manager/index.tsx:129` | 新建类目 input，中文类目名 | **真实，优先级中**。 |
| `frontend/components/crm/crm-category-manager/index.tsx:163` | 重命名类目 input | **真实，优先级中**。 |
| `frontend/app/dashboard/operations/project-launch/templates/workflow-template-editor.tsx:542` | 新增阶段名称 input，中文 | **真实，优先级中**。 |
| `frontend/components/dashboard/project-context/dynamic-context-card.tsx:185` | 维度名称 input，中文 | **真实，优先级中**。 |
| `frontend/app/dashboard/operations/sku-info/page.tsx:704` | SKU / ASIN 搜索 input | **真实但低影响**：输入内容多为 ASCII；用户用中文输入法时仍可能在组合期触发搜索。 |
| `frontend/app/dashboard/finance/commission-management/detail-tab.tsx:195` | `type="number"` 金额输入 | **误报**：number input 不涉及 IME 组合。 |
| `frontend/components/crm/crm-table/index.tsx:153` | `type="number"` 页码输入 | **误报**。 |
| `frontend/components/crm/lead-table.tsx:242` | `type="number"` 页码输入 | **误报**。 |

指南给出的修法是：在 `event.key === 'Enter'` 分支里先 `preventDefault()`，再检查 `event.isComposing`；Safari 存在 `compositionend` 早于确认 Enter `keydown` 的已知问题，建议同时检查 `event.keyCode === 229`。

#### `field-sizing: content`（1 条）

`frontend/components/chat/chat-input.tsx:73` 现在用 `textarea.scrollHeight` 手动算高度。指南建议改为 CSS：

```css
textarea {
  field-sizing: content;
  width: 100%;
  min-block-size: 3lh;
  max-block-size: 10lh;
}
```

关键事实：

- `field-sizing` 自 2026-06-16 起 Baseline newly available，Chrome 123 / Edge 123 / Firefox 152 / Safari 26.2 支持。
- 显式 `height` / `width` 会覆盖 `field-sizing`，需要同时重置。
- 不支持时是渐进降级：输入框保持固定尺寸并内部滚动，不影响功能。
- 当前 JS 逻辑可作为旧浏览器 fallback；如果目标浏览器都较新，可只保留 CSS。

#### 密码字段 `autocomplete`（2 条）

`frontend/app/dashboard/system/account-management/page.tsx:502`（创建账号初始密码）和 `:572`（重置密码）都缺少 `autocomplete`。这两处是管理员给他人设置密码，不是当前用户的注册表单，但补 `autocomplete="new-password"` 可以阻止密码管理器把已有密码填进“新密码”字段，低风险。

#### `max-height` 过渡（1 条）

`frontend/components/digital-employee/digital-employee-warm.module.css:1589` 用 `max-height: 0 → 80px` 做详情展开。指南建议用 `interpolate-size: allow-keywords` + `block-size: auto`；但本机指南数据明确写明 `interpolate-size` 目前只有 Chrome 129+ / Edge 129+ 支持，Firefox 和 Safari 不支持。因此：

- 若产品只支持 Chromium 内核，可作为渐进增强；
- 若仍需 Firefox / Safari，保留 `max-height` 方案更稳，或用 `@supports` 包一层新写法；
- 这条优先级低于 IME 和 `field-sizing`。

### 3.5 审视结论

- **准确率：** 14 条中 3 条明确误报（number input），其余 11 条可评估；误报主要来自“只看 `keydown` + Enter，不看 input 类型”。
- **覆盖范围：** `legacy-scan` 只跑 33/250 个 guide 的确定性规则，未覆盖的 guide（例如 `dialog`、`popover`、`responsive-table`）不代表没有问题。
- **能力边界：** 它不懂 React state、Next.js App Router、Radix 组合逻辑，也不做运行时验证、视觉检查、axe/Lighthouse 检查。
- **正确用法：** 把扫描结果当“线索”，用 guide 的 Keep/Drop 条件和源码逐条复核，再决定是否改。

## 4. 现代组件集成判断

### 4.1 当前栈与约束

- Next.js 16.2.4 + React 18.3.1，App Router。
- UI 以 Radix primitives + 本地 Warm Ledger 组件为主；已有 Dialog、Popover、Tooltip、Select、Tabs 等可访问性实现。
- 样式为 Tailwind 3.4 + CSS Modules；V4 Warm Ledger 是现行设计权威。
- 当前阶段只做桌面端；但这不等于可以忽略 Firefox / Safari，仍要按产品实际浏览器基线决定。

### 4.2 候选能力矩阵

| 能力 | 对应 guide | 指南给出的支持情况 | 对当前前端的建议 |
| --- | --- | --- | --- |
| 原生 `<dialog>` | `dialog` | 原生提供焦点管理、top layer、Esc / 返回手势、inert 背景 | 新写的简单确认框 / 表单弹窗可评估；不要给原生 dialog 再加 `role="dialog"`、`aria-modal` 或手写 focus trap。复杂嵌套、动画、受控状态仍优先用现有 Radix Dialog。 |
| Popover API | `dialog`、`viewport-aware-dropdowns` | Baseline 2025-01-27；Chrome 116 / Edge 116 / Firefox 125 / Safari 17 支持 | 适合菜单、tooltip、非模态面板；可作为 Radix Popover 的渐进增强候选，不建议一次性替换现有实现。 |
| Invoker Commands（`command` / `commandfor`） | `declarative-dialog-popover-control` | Baseline 2025-12-12；Safari 26.2 起支持 | 可用声明式开合代替部分 JS；旧浏览器需要 polyfill 或保留 JS 路径。 |
| `closedby` | `dialog` | Chrome 134 / Edge 134 / Firefox 141；Safari 不支持 | 只能当渐进增强；点击外部关闭仍需兼容路径。 |
| Anchor Positioning | `viewport-aware-dropdowns` | **仅 Safari 27 支持，Chrome / Edge / Firefox 不支持** | **现在不要替换** Radix / Floating UI 的定位逻辑；用 `@supports` 渐进尝试即可。 |
| `field-sizing: content` | `form-fields-automatically-fit-contents` | Baseline 2026-06-16；四大引擎均支持 | 聊天输入框最适合先试；保留 JS fallback 或用 `@supports` 渐进增强。 |
| IME-safe Enter | `ime-safe-enter-submit` | `isComposing` Chrome/Edge/Firefox 支持；Safari 有事件顺序 bug | 所有自定义 Enter 提交都应加 `isComposing` + `keyCode === 229` 检查；这是本次最高价值修复。 |
| `interpolate-size` | `animate-to-intrinsic-sizes` | 仅 Chrome 129+ / Edge 129+ | 只在 Chromium 目标下用；否则保留 `max-height` 或 `@supports` 双路径。 |
| Container Queries | `responsive-design`、`size-aware-styling` | 指南推荐；按目标浏览器基线验证 | 适合 dashboard 卡片按容器宽度自适应；与当前桌面端范围不冲突，可作为后续渐进改造。 |
| `:user-invalid` | `forms`、`required-field-feedback` | 指南推荐；按目标浏览器基线验证 | 可用于表单校验态，减少“刚打开就报错”；需与现有错误提示组件契约对齐。 |

### 4.3 不建议做的事

- 不要因为指南推荐原生 `<dialog>` 就把所有 Radix Dialog 替换掉：现有组件已经处理焦点、嵌套、动画和受控状态，替换成本高。
- 不要给原生 `<dialog>` 加 `role="dialog"` / `aria-modal` 或手写 focus trap，指南明确说浏览器已经提供。
- 不要在 Chrome / Edge / Firefox 上强推 Anchor Positioning；当前支持面不够。
- 不要让指南覆盖 V4 Warm Ledger 的视觉决定；指南管平台能力和可访问性，不管品牌与布局规范。
- 不要把 `legacy-scan` 接成 CI 阻断门禁：它有误报，且只覆盖约 20% 语料，适合周期性体检。

### 4.4 建议的试点顺序

1. **`frontend/components/chat/chat-input.tsx`（首选“A 点”）**
   - 同时命中 IME 和 `field-sizing`，当前引用只有 `frontend/components/chat/ai-chat-window.tsx`（以及测试 mock），改动局部。
   - 预期收益：中文输入不再误发送；输入框高度逻辑从 JS 逐步转为 CSS。
2. **账号管理密码字段**
   - `frontend/app/dashboard/system/account-management/page.tsx` 两处加 `autocomplete="new-password"`，低风险。
3. **CRM / 工作流 / 动态上下文的 Enter 提交**
   - 聊天之外的 5 处真实 IME 问题（会话重命名、CRM 类目新增/重命名、工作流阶段、动态上下文），可抽一个共享的 `isImeComposing` 判断或 hook，避免每处重复。
4. **数字员工详情展开**
   - 只在确认浏览器基线以 Chromium 为主时再考虑 `interpolate-size`。

## 5. 推荐接入方式

### 5.1 团队 Codex

```bash
codex plugin marketplace add GoogleChrome/modern-web-guidance
codex plugin add modern-web-guidance@googlechrome
```

安装后新开 Codex session，让 skill 在涉及 HTML/CSS/客户端 JS 的任务中自动触发；也可以显式要求 agent 使用 `modern-web-guidance`。

### 5.2 前端工作流约定（建议）

在 `frontend/` 做 UI 改动前：

```text
1. 用 2–5 个词描述用户可见能力，先 search，不要先写代码。
2. 只 retrieve 与当前任务匹配的 guide；不要一次拉全部。
3. 按 guide 的实现步骤、Baseline、fallback 和 gotcha 落地。
4. 代码写完后对照 guide 自检；不要用 legacy-scan 代替具体功能的规范查询。
```

周期性体检（例如每季度或大版本前）：

```bash
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest legacy-scan frontend --json > /tmp/mwg-frontend-scan.json
```

把结果当候选清单，逐条按 Keep/Drop 条件复核，不直接批量改。

### 5.3 遥测与版本

- 建议在 shell profile 或 CI 里设置 `DISABLE_TELEMETRY=1`。
- 指南内容会随 Web 平台更新；升级前先看 `update` 输出和 changelog，避免同一天内不同 agent 使用不同版本。
- 本仓库已有 `skills-lock.json` 管理 GSAP skills；如果以后要把 modern-web-guidance 项目级纳入，先确认 lock 版本升级不会覆盖现有 hash。

## 6. 风险与边界

- **静态扫描误报**：本次 14 条中 3 条明确误报；扫描器不看 input 类型、React 状态和运行时行为。
- **覆盖不全**：只覆盖 33/250 个 guide 的确定性规则；`dialog`、`popover`、`responsive-table` 等能力不会被 `legacy-scan` 发现。
- **不是组件库**：它给实现模式和代码片段，不提供可直接安装的 React 组件。
- **不是自动重构器**：不会改代码、不会提 PR、不会跑测试。
- **浏览器支持差异大**：Anchor Positioning 目前仅 Safari 27；`interpolate-size` 仅 Chromium；`closedby` 不支持 Safari。必须按产品浏览器基线决定，不能只看“modern”。
- **与现有设计系统冲突的风险**：指南推荐原生控件，但本仓库的 Warm Ledger、Radix 封装和交互契约优先；任何替换都要单独评审。
- **供应链与遥测**：npm 包会执行安装脚本/CLI；建议 pin 版本、审查来源，生产环境关闭遥测。
- **供应商 eval 数据**：README 中的 uplift（例如 codex_cli 54% → 82%）是 vendor 自测结果，未在本仓库独立复现，只能作为参考。

## 7. 复现命令

```bash
# 1. 零安装试用
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest --help
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest search "animate a dialog modal backdrop"
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest retrieve "animate-to-intrinsic-sizes"

# 2. 当前前端扫描
DISABLE_TELEMETRY=1 npx -y modern-web-guidance@latest legacy-scan frontend --json

# 3. Codex 插件（隔离验证时设置 CODEX_HOME）
codex plugin marketplace add GoogleChrome/modern-web-guidance
codex plugin add modern-web-guidance@googlechrome
codex plugin list

# 4. 全局 skill（不污染仓库 skills-lock.json）
npx -y skills add GoogleChrome/modern-web-guidance \
  -g -a codex -s modern-web-guidance -y --copy
```

## 8. 待确认

1. “A 点”如果指某个具体页面 / 路由，请补充页面名；本次只能按仓库级扫描和代表性组件验证。
2. 是否要在用户真实环境中安装（本次只在 `/tmp` 隔离 HOME / `CODEX_HOME` 验证，未改真实配置）。
3. 是否要先做 `chat-input` 试点（IME + `field-sizing`），还是先处理账号管理密码字段这类低风险项。
