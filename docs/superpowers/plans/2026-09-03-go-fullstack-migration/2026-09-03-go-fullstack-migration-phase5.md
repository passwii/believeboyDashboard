# Phase 5 — 前端 API 抽象层 + Wails 桌面端

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 4 全切完成（Go API 生产稳定）——桌面端内嵌的前端必须打稳定 API，提前做返工风险高

**Goal:** 前端 84 页面零业务改动，同时跑在 Vercel（Web）和 Wails 桌面壳里；交付 Win/macOS 安装包。

**Architecture:** 前端加一层 `ApiTransport` 抽象：Web 版走 `fetch('/api/v1/...')`（经 Vercel rewrite 到 Go API），桌面版走 `window.go.*` 桥接（同进程直调，无 HTTP 开销）。Go 侧业务逻辑（`pkg/` + `internal/service`）被 `services/api` 和 `desktop/` 共享——**写一次，两端用**。

**前置检查（本 Phase Day 1）：** 确认 Wails 最新 stable 版本（写 plan 时为 v2；若 v3 已 stable 则用 v3，决策记入本文件并通知用户）。本机需 `go1.26`（✅ 已有）+ `npm/pnpm` + 平台 WebView 运行时。

## 任务

### Task 5.1：前端 Transport 抽象（唯一允许改前端的 Task）

**现状：** `frontend/lib/` 下有 `api/`、`client-api/`、`server/`、`fetch-with-timeout.ts`、`error-utils.ts` 等；各页面直调这些 client。先审计再抽象。

- [ ] Step 1: 审计：`grep -rn "fetch(" frontend/app frontend/components frontend/lib --include="*.tsx" --include="*.ts" | grep -v test | wc -l` 统计直调点；列出绕开 `lib/` 的 Top 10 文件，先收敛到 `lib/client-api`（纯搬运，不改行为，前端测试全绿）。
- [ ] Step 2: 新建 `frontend/lib/transport.ts`：`ApiTransport` 接口（`get/post/put/patch/delete/stream`，SSE 复用现有 chat 组件的 EventSource 逻辑）；`FetchTransport`（现有行为原样包一层）；`WailsTransport`（调 `window.go.bridge.*`，缺失时抛错提示“请用桌面版后端”）。
- [ ] Step 3: `lib/client-api` 全量改走 `transport` 单例（环境变量 `NEXT_PUBLIC_TRANSPORT=wails|fetch` 切换）；`pnpm lint && pnpm build && pnpm test` 全绿；Vercel 预览部署验证 Web 版无回归。
- [ ] Step 4: Commit（前端分支常规流程走 Tia review）：`refactor(前端): API 调用收敛到 Transport 抽象层`。

### Task 5.2：桌面桥接层（`go/desktop`）

- [ ] Step 1: `desktop/app.go`：Wails v2 `Bind` 一个 `Bridge` struct，方法与 `ApiTransport` 接口一一对应（`Get/Put/.../Stream` 返回 JSON 字符串；Stream 用 Wails Events 逐帧发，前端 `WailsTransport.stream` 订阅）。
- [ ] Step 2: Bridge 内部直调 `internal/service`（与 `services/api` 的 handler 调同一 service 函数——**不是 HTTP 回环**，这是桌面版零延迟的关键）。
- [ ] Step 3: 认证：桌面版不用 cookie；启动时内嵌登录窗 → 换 JWT 存系统 keyring（`zalando/go-keyring`）→ 每次 Bridge 调用带 token（服务端复用 `internal/auth` 校验）。next-auth 仅 Web 版保留。
- [ ] Step 4: 系统功能：托盘图标 + 通知（告警/报表完成）+ 开机自启选项 + 原生文件对话框（替换浏览器下载：报表/Excel 直存本地）。
- [ ] Step 5: Commit：`feat(go): Wails 桌面桥接层与系统功能`。

### Task 5.3：打包与分发

- [ ] Step 1: `wails build` 产物：macOS（arm64 + amd64，签名/公证流程写文档）、Windows（nsis 安装器）。单文件体积目标 < 80MB（含 WebView 运行时除外——WebView2 需随包引导安装，写进安装说明）。
- [ ] Step 2: 前端构建产物嵌入流程：`pnpm build`（frontend）→ `wails build -o`（desktop），写进 `go/desktop/README.md` 一键脚本。
- [ ] Step 3: 灰度：先内部 3–5 人用 1 周（崩溃上报 + 自动更新通道：wails updater 或手动下载页二选一，决策记文档）。
- [ ] Step 4: Commit：`docs(go): 桌面端打包分发手册`。

## Exit Criteria

- [ ] 同一份前端构建产物在 Vercel Web 版与桌面版行为一致（冒烟清单：登录/84 页抽查 20 页/图表/导出/聊天流式）
- [ ] 桌面版内存 < 150MB（对比 Electron 方案 300MB+；Wails 目标 < 100MB）
- [ ] 安装包可下载安装，自动更新通道就绪
