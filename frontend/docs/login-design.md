# BLF-1244 登录页接入

## 设计权威

用户在 BLF-1244 评论中选定 B · 飞翼，并于 2026-10-07 明确回复「已正式确认可以接入」。实施以该线程最新 `login-template-preview.html` 为准，不重新选型。此页属于 V3 Terminal 登录入口的已确认局部设计，不改后台公共令牌。

- 桌面：72 px 页顶品牌/主题栏；森林绿品牌区与登录区按 1.12 : 0.88 分栏。
- 700 px 以下：62 px 顶栏，表单先于品牌区，装饰更淡、更紧凑。
- 系统中文字体、零圆角输入与按钮、绿色主操作、1 px 分隔；50 px 登录控件为用户确认的入口专用规格。
- 颜色在 `components/login/login.css` 的 `.login-entry` / `.dark .login-entry` 内成对定义，不污染其他页面。
- 保留确认稿的栅格、方形路径、钴蓝飞翼、文案和排版。Impeccable 的 grid advisory 为已确认视觉，不扩散为全站规则。
- 栅格、英文标签、系统展示字和较紧 tracking 是此确认稿的局部选择，不作为其他页面的通用设计规范。

## 状态与行为

认证仍走原 credentials 流程，保留网络重试、请求超时、站内 callback 安全检查与导航 loading 生命周期。不修改 Auth.js、middleware、后端、权限或 API 契约。

点击提交即显示「正在验证…」/「正在验证账号信息，请稍候。」并播报验证状态。所有表单控件禁用；同步 ref 拦截重复提交。500 ms 是从提交开始计算的最短展示时长，非额外等待或认证完成假象；慢请求持续等待真实结果。卸载会清理新增计时器，失败恢复输入与错误提示。

路径在不可见/文档隐藏时暂停；`prefers-reduced-motion` 禁用路径与按钮动画。

## 图标溯源

`app/icon.svg` 与用户选定的 B · 飞翼原始 SVG 一致：#2755d9 圆底、三片白翼。`app/favicon.ico` 保留 16 / 32 / 48 / 64 px 四帧；`app/apple-icon.png` 为原 SVG 在 Chromium canvas 按 180 px 独立栅格化的原文件，内嵌 Source 元数据。使用 Next App Router 文件约定，覆盖全站标签图标和 Apple 图标；不修改 root layout。

## 验证与未完成项

- T3 前端全量：238 文件、1685 passed / 0 failed。
- 全仓 lint：0 errors / 27 warnings（其他页面的存量告警）；登录目录 lint：0 errors / 0 warnings。
- `pnpm build`：exit 0，包含 API 类型同步检查和 TS 检查。
- 红绿测试：新增最短展示、慢请求、重复提交、卸载清理和无目录断言先失败后通过；保留认证失败、网络重试、callback 安全、默认跳转等回归。
- 真实 Next production 页面 Ego Browser DOM 检查：1440 / 390 px 无横向溢出，明暗令牌正确，密码显隐正常，reduced-motion 为 `none`，页面 metadata 引用三种新图标。
- Impeccable detector：0 errors / 0 warnings / 1 advisory（确认稿装饰网格）。

内联 finish review（本环境无子 agent 工具）：`disposition: recapture`。桌面、移动、暗色的 `Page.captureScreenshot` 均超时，未取得有效页面截图，因此不宣称完整视觉验收通过；需要 PR preview 上补拍并对照确认稿。未将 DOM 检查或图标展板冒充视觉截图。文档复核保持后台既有 `docs/design-spec.md` 权威，不新增/改写全站 DESIGN.md。
