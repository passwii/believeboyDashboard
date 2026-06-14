# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚡ CodeGraph 语义知识图谱（优先使用）

本项目已初始化 **CodeGraph**，通过语义知识图谱实现代码库的即时查找，比文件扫描快 10-100 倍。

### 核心规则

**查找文件、符号、代码结构时，优先使用 CodeGraph 工具而非 Grep/Glob。**

### 可用工具

| 工具 | 用途 | 示例 |
|------|------|------|
| `codegraph_status` | 查看索引健康度（文件数/节点数/边数/语言分布） | 上线前、debug MCP 时 |
| `codegraph_search` | 按名称快速搜索符号（仅 location，不带源码） | 知道名字但不知在哪 |
| `codegraph_explore` | **主力工具**：问"X 是怎么工作的" / 给一组符号名，返回 verbatim 源码分组 | 几乎所有"了解/调查/实现"任务的第一步 |
| `codegraph_node` | 看单个符号的完整 body（当 `explore` 因 token 限制被裁剪时） | 重载方法、过深 body |
| `codegraph_callers` | 哪些代码调用了 X | 重构前找全部引用 |
| `codegraph_callees` | X 调用了哪些 | 理解函数依赖 |
| `codegraph_impact` | 多层依赖图（修改前必跑） | 改公共函数前评估 blast radius |
| `codegraph_files` | 文件树 + 元数据 | 项目布局浏览 |

> **注**：CLAUDE.md 早期版本提到 `codegraph_context` / `codegraph_node` 等 — `codegraph_context` 在当前 MCP 版本中不存在，已删除。

### 调用方法

使用 `mcp__codegraph__*` 前缀的工具，例如：

```
mcp__codegraph__codegraph_status
mcp__codegraph__codegraph_search query="ProductCost"
mcp__codegraph__codegraph_explore query="calculate_revenue 的调用链与所有实现"
mcp__codegraph__codegraph_impact symbol="process_report"
```

### 何时使用

**默认路径**：对于"X 怎么工作 / 架构 / 某 bug / X 在哪 / 概览某模块" → 第一步 `codegraph_explore`，**多数情况下一次调用就够**。Codegraph IS 预构建的搜索索引，**不要**把 lookup 委托给 Read/Grep 子任务（重复工作 + 更贵）。

| 意图 | 工具 |
|---|---|
| "X 是怎么工作的" / 架构 / 排查 bug / "X 在哪" / 概览某区域 | `codegraph_explore`（PRIMARY — 第一步，one-capped call） |
| "X 如何到达 Y" / 跨函数的数据流 / 流程路径 | `codegraph_explore`，把跨流的符号全列上（含动态分派） |
| "符号 X 在哪"（只要 location） | `codegraph_search` |
| "谁调用 X" / "X 调用谁" / "改 X 会破什么" | `codegraph_callers` / `codegraph_callees` / `codegraph_impact` |
| "X 的完整 body"（被 explore 裁剪后） | `codegraph_node` |
| 索引是否健康 / MCP 是否活着 | `codegraph_status` |

只在你**确认** codegraph 没覆盖的细节上才用 Read/Grep。

### 实战经验（2026-06 起记录）

1. **首选 `codegraph_explore` 而不是 `codegraph_search`**：后者只给 location（"X 在 file:line"），前者直接给 verbatim 源码，多数场景一次到位。`search` 适用于"我只想要 location 列表"（如 grep 替代）。
2. **改函数前必跑 `codegraph_impact`**：默认 depth=2，会列出多层调用方。VAT 发票模块的 `computeInvoiceTotal` 当时在 3 处被引用（client + summary + pdf），改之前查一下能避免漏改。
3. **`.test.ts` 后缀的文件不被 codegraph 识别为"覆盖测试"**：`codegraph_explore` 的 blast radius 报告里会标 "⚠️ no covering tests found" — 这可能是误报，要人工核对。
4. **React 动态分派也能追**：`VatInvoiceClient` → `<SellerCard>` 的 JSX 渲染关系 codegraph 能识别，会在 explore 输出里以 "Dynamic-dispatch links" 段单独列出。
5. **索引滞后约 1 秒**：写完代码后等几秒再查，否则可能漏新加的符号。如要即时确认可跑 `codegraph_status` 看 `Files indexed` 是否增加。
6. **MCP 静默/不可用时**：先跑 `codegraph_status`；如果工具直接报"未注册"，说明 `mcpServers` 没配好，需要在 `~/.claude/settings.json` 加 `mcpServers.codegraph` 段。

### 启动 Explore 代理时

告诉 Explore 代理使用 CodeGraph 工具加速探索。

### 本次实践沉淀（BEL-93）

1. **初始化/健康检查**：首次进入仓库先跑 `codegraph_status`；若提示未初始化，在仓库根目录执行 `codegraph init`。
2. **文件树路径要用相对路径**：`codegraph_files` 的 `path` 参数传 `.`；传绝对路径会命中 “No files found matching the criteria”。
3. **精准定位优先 `node` + `file/line`**：`explore` 适合宽泛问题，但遇到 `Index` 这类泛名可能混入无关 blast radius；已知位置时用 `codegraph_node symbol="..." file="..." line=...` 看单个 body 最稳。
4. **前端登录入口实践**：`codegraph_search("login")` 找到 `frontend/app/login/page.tsx:6` 的 `LoginPage`，继续追到 `frontend/components/login/sign-in-card.tsx:67` 的 `handleSignIn`，其通过 `signIn("credentials", ...)` 发起登录。
5. **后端登录入口实践**：同一个 `codegraph_search("login")` 找到 `backend/app/api/v1/endpoints/auth.py:82` 的 `login`，`codegraph_node` 显示它会先做 IP/邮箱限流，再查 `public.user_accounts`、校验密码、写审计日志并创建 Redis session。
6. **重构前必跑影响面**：对 `frontend/lib/backend-auth.ts:125` 的 `buildBackendAuthHeaders` 跑 `callers/callees/impact`，确认它被 admin users、AI chat、file upload、password、proxy/cache 等 19 个直接调用方使用，修改前需要覆盖这些路径。

---

## Project Overview

BelieveBoy Dashboard is a cross-border e-commerce operations management platform. It has a **Next.js 14 frontend** and a **FastAPI backend**, both in a single monorepo under `frontend/` and `backend/`.

## Running the Project

### Frontend
```bash
cd frontend && pnpm install && pnpm dev        # http://localhost:3000
pnpm build && pnpm start                      # production
pnpm lint                                     # linter
```

### Backend

**Local Development Environment (Miniconda)**

This project uses **Miniconda** for local development, not `venv`. The Python interpreter is located at `/Users/damon/miniconda3/bin/python3` (Python 3.12.7).

```bash
cd backend
# Activate the conda environment (if using one) or use python3 directly
conda activate <your-env-name>  # or skip if using base environment
pip install -r requirements.txt
cp .env.example .env                          # fill in DATABASE_URL + API_KEY
./run_api.sh                                  # http://localhost:8000
alembic upgrade head                          # run migrations
pytest                                        # run tests (cd backend first)
pytest tests/path/to/test_file.py::test_name  # single test
```

> **Important**: When running tests or scripts, the system may default to `.venv`. Always ensure you're using the correct Miniconda Python interpreter. Verify with `which python3` before running commands.

### One-off Backend Scripts
- `python scripts/seed_admin_user.py` — create admin user (use `--reset-password` to rotate)
- `python scripts/init_and_import_projects.py --file=/path/to.csv` — init projects table + import CSV
- `python scripts/init_user_accounts.py` — init user accounts + seed admin in one step
- `python scripts/import_blf_basic_info.py --file=/path/to/BLF_Basic_Info.csv` — import product data
- `alembic revision --autogenerate -m "desc"` — create migration; `alembic upgrade head` to apply

## Architecture

### Frontend → Backend Communication
The frontend **never connects to PostgreSQL directly**. All backend calls go through a Next.js API route proxy at `frontend/app/api/backend/[...path]/route.ts`, which forwards to `BACKEND_API_BASE_URL` (default `http://127.0.0.1:8000`) with `X-API-Key`, `X-User-Id`, `X-User-Name`, `X-Operator`, and `X-Is-Admin` headers. The backend validates the `X-API-Key` header via `app/core/security.py`.

### Backend API
- Entry: `backend/app/main.py`
- Routes: `backend/app/api/v1/router.py` (aggregates all endpoint routers)
- Endpoint modules: `backend/app/api/v1/endpoints/` — key groups:
  - `auth`, `users`, `projects`, `product_costs`, `exchange_rates`
  - `daily_reports`, `monthly_reports`, `product_analysis`, `product_analysis_reports`
  - `daily_analysis`, `ad_analysis`, `ad_upload`, `inventory_replenishment`
  - `pricing_calculation`, `store_accounting`, `shipment_schedules`, `store_sku_pricing_snapshots`
  - `category_research`, `report_upload`
  - `ai_chat`, `ai_file_upload`, `ai_insight`, `jobs`, `uploads`
  - `system_management`, `presence`, `health`
  - `return_analysis`, `project_goals`, `rpa_reports`
- Services: `backend/app/services/` (one service file per resource)
- Models: `backend/app/models/` (SQLAlchemy ORM models)
- Schemas: `backend/app/schemas/` (Pydantic request/response models)
- DB session: `backend/app/db/session.py`

### Frontend Structure
- `frontend/app/dashboard/` — page components (Next.js App Router):
  - `ai-panel/` — AI chat
  - `ai-insights/` — AI-powered data insights and analytics
  - `operations/` — site/store navigation, collaboration
  - `data-reporting/` — daily-report, monthly-report, product-analysis, pricing-calculation, store-accounting, new-product
  - `data-analysis/` — financial-data, weekly-product-analysis, daily-analysis, ad-analysis, inventory-analysis, inventory-replenishment, return-analysis, project-goals
  - `data-management/` — sku-cost, exchange-rate, report-upload, ad-upload, shipment-management
  - `system-management/` — account-management, operator-management, project-info, commission-management, commission-overview, logs, auto-upload
  - `tools/` — research-analysis, rpa-reports
  - `changelog/`
- `frontend/components/dashboard/` — shared dashboard components
- `frontend/components/ui/` — shadcn/ui base components
- `frontend/components/notifications/` — notification/toast system
- `frontend/lib/` — utilities, auth helpers, backend proxy helpers
- `frontend/app/api/backend/[...path]/route.ts` — proxies all backend calls; authenticates via NextAuth session, forwards `X-API-Key`, `X-User-Id`, `X-User-Name`, `X-Operator`, `X-Is-Admin` headers

### Auth
- **Frontend**: NextAuth.js v4 (configured in `frontend/app/api/auth/[...nextauth]/route.ts`)
- **Backend**: `X-API-Key` header validated by `require_api_key` in `app/core/security.py`. All routes except `/api/v1/health` are protected. Per-request user context comes from `X-Operator` / `X-User-Id` headers (set by the frontend proxy).

### Background Jobs
Jobs run as one-off Python processes via `backend/app/tasks/scripts/`. Celery + Redis are configured but not required in the current mode.

### autoReportUpload
A standalone Python service (`autoReportUpload/`) that monitors configured directories for new report files, auto-recognizes and uploads them to the backend. It is **not** part of the FastAPI app — run independently:

```bash
cd autoReportUpload && source ../backend/.venv/bin/activate
python run.py                  # normal mode (periodic loop)
python run.py --dry-run        # recognize only, no DB writes or file moves
python run.py --once           # single scan, no loop
```

### AI Chat
Uses an external AI provider configured via `AI_CHAT_PROVIDER_*` env vars. Web search is available via `AI_CHAT_WEB_SEARCH_*` vars. Chat history is stored in `AIConversation` / `AIMessage` models. AI-powered data insights are available via the `ai_insight` endpoint.

## Environment Variables

**Frontend** (`frontend/.env.local`):
- `BACKEND_API_BASE_URL` — backend URL (e.g. `http://127.0.0.1:8000`)
- `BACKEND_API_KEY` — shared API key
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET`

**Backend** (`backend/.env`):
- `DATABASE_URL` — PostgreSQL connection string (required)
- `API_KEY` — must match `BACKEND_API_KEY` in frontend
- `UPLOAD_ROOT`, `RESULT_ROOT` — file storage paths; `MAX_UPLOAD_BYTES` limits upload size
- `AI_CHAT_PROVIDER_BASE_URL`, `AI_CHAT_PROVIDER_API_KEY`, `AI_CHAT_DEFAULT_MODEL`, `AI_CHAT_MODEL_BLOCKLIST`, `AI_CHAT_PREMIUM_MODELS`, `AI_CHAT_BASIC_MODELS`, `AI_CHAT_TIMEOUT_SECONDS` — AI provider config
- `AI_CHAT_WEB_SEARCH_BASE_URL`, `AI_CHAT_WEB_SEARCH_API_KEY` — web search config
- `REDIS_*` — Redis for presence features (optional)

## Database
PostgreSQL only — no SQLite fallback. All models are in `backend/app/models/`. Use Alembic for migrations.

### Alembic Migration Naming Convention
Alembic 迁移脚本命名格式：`YYYYMMDD_NNN_description.py`
- `YYYYMMDD` — 日期，如 `20260516`
- `NNN` — **三位序号**，从最新迁移的序号开始递增，如 `121`、`122`
- `description` — 简短的英文描述

**注意**：序号是 3 位数字（如 `001`、`120`），不是从 1 开始重新计数。

#### Revision ID 规范（短 ID）
- 脚本内的 `revision` 和 `down_revision` 必须使用**纯数字短 ID**（如 `'131'`、`'132'`）。
- **严禁**使用长格式（如 `'20260522_131'`）或随机 hash（如 `'48baadd13dac'`）。
- **严禁**修改已运行到数据库中的 migration 的 `revision` ID（数据库 `alembic_version` 表已记录该 ID）。
- 新 migration 的 `down_revision` 必须指向前一个版本的短数字 ID，确保版本链为单链无分支。

查询最新序号：
```bash
cd backend && ls alembic/versions/ | grep "^202605" | sort | tail -5
# 或查看分支情况
/Users/damon/miniconda3/bin/python3 -m alembic heads
```

## Additional Docs
- `backend/README.md` — detailed backend documentation
- `backend/REDIS_PLAN.md` — Redis integration plan (Celery/Redis are optional)
- `backend/docs/report-processing-sync-spec.md` — report processing sync specification

## Design Context

### Users
Operations teams managing cross-border e-commerce on Amazon. They live in the dashboard daily — monitoring KPIs, uploading reports, running AI-generated analysis. They are power users who need efficiency, clarity, and trust in the data. They are not casual consumers; the interface should respect their expertise and time.

### Brand Personality
**Professional, data-driven, calm confidence.** Like Linear or Stripe — tools that feel precise and in-control. Not playful, not corporate-stiff. The brand name "BelieveBoy" suggests human warmth beneath the professionalism.

Three-word personality: **Precise · Clear · Trusted**

### Aesthetic Direction
B2B SaaS dashboard with a light-mode-first design. Inspired by Linear's information density and clarity, Vercel's clean white surfaces, and Stripe's confident use of color for data semantics. Anti-references: busy enterprise dashboards with cluttered cards, or generic dark-only tech UIs.

- Light mode primary, dark mode fully supported
- Frosted glass surfaces (`.dashboard-surface`) for visual layering without clutter
- Data colors: green (positive), amber (warning), red (negative), neutral gray — semantic, not decorative
- Generous but purposeful whitespace; information density is okay on data tables

### Design Principles
1. **Data clarity first** — Every visual decision serves the numbers. Charts, colors, and spacing must make data easier to read, not prettier to look at.
2. **Calm surfaces, confident accents** — Light neutral backgrounds with a single strong blue primary. Color appears mostly on data (charts, status badges) and interactive elements.
3. **Motion with purpose** — Animations communicate state (streaming, loading, transitions). Never decorative. Respect `prefers-reduced-motion`.
4. **Consistent surface language** — Use `.dashboard-surface`, `.dashboard-panel`, `.dashboard-toolbar` consistently. Avoid ad-hoc card styling.
5. **Typography creates hierarchy** — Space Grotesk for display/numbers, Manrope for UI text. Large display numbers for KPIs, small kicker labels for metadata.

## 测试规则

每次完成前端或后端开发后，必须执行**两轮测试**。

### 规则 1：技术测试（每次必做）

**前端开发**（按顺序执行，先 lint 后 build）：

```bash
cd frontend && pnpm lint    # 静态检查（2-5 秒，未通过不得进入 build）
cd frontend && pnpm build   # 生产构建（30-90 秒）
```

- `pnpm lint` 失败 → 立即修复（清空警告、修复错误）
- `pnpm build` 失败 → 立即修复
- 两步全部通过 → 继续业务测试

> lint 在每次前端改动后都必跑，不要攒到最后。lint 能抓到 build 抓不到的错误（未使用变量/导入、hook 依赖缺失、未使用 props、不推荐的写法等）。

**后端开发**：
```bash
cd backend && pytest
# 或单个测试
pytest tests/path/to/test_file.py::test_name
```
- 测试失败 → 立即修复
- 测试成功 → 继续业务测试

> **前端不引入单元测试框架**（无 vitest / jest / RTL）。前端代码靠 `pnpm lint` + `pnpm build` + 业务测试清单三层验证。新建纯函数模块时不要主动装 vitest；如果确实需要写单测，先问用户。

### 规则 2：业务测试（每次必做）

功能完成后，AI agent 必须提供**业务测试清单**给用户，用户手动执行并反馈。

### 规则 3：反馈循环

用户反馈后：
- 如果是 bug → 修复并重新执行两轮测试
- 如果是功能建议 → 记录并评估是否纳入下个迭代

---

## 如何向 AI 反馈

完成业务测试后，请按以下格式反馈：

```markdown
## 测试反馈

**功能**：<功能名称>
**URL**：<测试页面 URL>

### 技术测试结果
- [ ] 前端构建通过
- [ ] 后端测试通过（如果有）

### 业务测试结果
| 测试项 | 结果 | 说明 |
|--------|------|------|
| 测试项 1 | ✅/❌ | 说明 |

### 问题/建议
1. <问题描述>
2. <建议>
```

---

## Git 提交规范

> **⚠️ 所有 Commit 必须使用中文编写**
>
> 提交信息必须使用中文，包括标题和正文，以便团队成员理解变更内容。

### Commit 格式
```
<类型>: <简短中文描述>

[可选的详细说明]
```

### 示例
```
feat: 添加项目批量选择功能

新增项目列表的批量选择操作，支持批量删除和批量更新状态。
```

---

## Git Workflow

### Before Pushing
Always run `pnpm build` in the frontend directory before pushing to ensure the build passes. If there are build errors, fix them before pushing.

### Post-Push Hook (VPS Deployment)

This project uses a **post-push hook** at `.git/hooks/post-push` to automatically deploy to the VPS after each push to `main`. The hook runs `productEnvAgent/deploy_vps.py --auto`, which:
1. Git pull on server
2. Alembic migration
3. Service restart
4. Health check
5. Generates a deployment report in `docs/deployment/`

> **⚠️ AI Agent Limitation**: When `git push` is executed via an AI agent, the post-push hook does **not** trigger automatically. To work around this, the hook must be invoked manually after push. After any `git push origin main`, the agent **must** also run:
```bash
.git/hooks/post-push "refs/heads/main" "https://github.com/passwii/believeboyDashboard.git"
```

The hook script is at `.git/hooks/post-push` — it takes two arguments: the local ref (e.g. `refs/heads/main`) and the remote URL.

## Key Conventions
- Backend uses Pydantic v2 (`pydantic-settings` for env config)
- Frontend uses React 18 with TanStack Table v8 and Recharts
- Next.js App Router pages are split: `page.tsx` (server component) + `*-client.tsx` (client component) when interactivity is needed
- All backend API endpoints follow `/api/v1/{resource}/` naming
- **Projects API**: 前端获取项目列表必须使用 `/api/v1/projects/manage` 而非 `/api/v1/projects`，因为 `/projects/manage` 有基于 `X-Operator` header 的权限控制，会根据当前用户过滤可访问的项目

<!-- superpowers-zh:begin (do not edit between these markers) -->
# Superpowers-ZH 中文增强版

本项目已安装 superpowers-zh 技能框架（20 个 skills）。

## 核心规则

1. **收到任务时，先检查是否有匹配的 skill** — 哪怕只有 1% 的可能性也要检查
2. **设计先于编码** — 收到功能需求时，先用 brainstorming skill 做需求分析
3. **测试先于实现** — 写代码前先写测试（TDD）
4. **验证先于完成** — 声称完成前必须运行验证命令

## 可用 Skills

Skills 位于 `.claude/skills/` 目录，每个 skill 有独立的 `SKILL.md` 文件。

- **brainstorming**: 在任何创造性工作之前必须使用此技能——创建功能、构建组件、添加功能或修改行为。在实现之前先探索用户意图、需求和设计。
- **chinese-code-review**: 中文 review 沟通参考——话术模板、分级标注（必须修复/建议修改/仅供参考）、国内团队常见反模式应对。仅在用户显式 /chinese-code-review 时调用，不要根据上下文自动触发。
- **chinese-commit-conventions**: 中文 commit 与 changelog 配置参考——Conventional Commits 中文适配、commitlint/husky/commitizen 中文模板、conventional-changelog 中文配置。仅在用户显式 /chinese-commit-conventions 时调用，不要根据上下文自动触发。
- **chinese-documentation**: 中文文档排版参考——中英文空格、全半角标点、术语保留、链接格式、中文文案排版指北约定。仅在用户显式 /chinese-documentation 时调用，不要根据上下文自动触发。
- **chinese-git-workflow**: 国内 Git 平台配置参考——Gitee、Coding.net、极狐 GitLab、CNB 的 SSH/HTTPS/凭据/CI 接入差异与镜像同步配置。仅在用户显式 /chinese-git-workflow 时调用，不要根据上下文自动触发。
- **dispatching-parallel-agents**: 当面对 2 个以上可以独立进行、无共享状态或顺序依赖的任务时使用
- **executing-plans**: 当你有一份书面实现计划需要在单独的会话中执行，并设有审查检查点时使用
- **finishing-a-development-branch**: 当实现完成、所有测试通过、需要决定如何集成工作时使用——通过提供合并、PR 或清理等结构化选项来引导开发工作的收尾
- **mcp-builder**: MCP 服务器构建方法论 — 系统化构建生产级 MCP 工具，让 AI 助手连接外部能力
- **receiving-code-review**: 收到代码审查反馈后、实施建议之前使用，尤其当反馈不明确或技术上有疑问时——需要技术严谨性和验证，而非敷衍附和或盲目执行
- **requesting-code-review**: 完成任务、实现重要功能或合并前使用，用于验证工作成果是否符合要求
- **subagent-driven-development**: 当在当前会话中执行包含独立任务的实现计划时使用
- **systematic-debugging**: 遇到任何 bug、测试失败或异常行为时使用，在提出修复方案之前执行
- **test-driven-development**: 在实现任何功能或修复 bug 时使用，在编写实现代码之前
- **using-git-worktrees**: 当需要开始与当前工作区隔离的功能开发或执行实现计划之前使用——创建具有智能目录选择和安全验证的隔离 git 工作树
- **using-superpowers**: 在开始任何对话时使用——确立如何查找和使用技能，要求在任何响应（包括澄清性问题）之前调用 Skill 工具
- **verification-before-completion**: 在宣称工作完成、已修复或测试通过之前使用，在提交或创建 PR 之前——必须运行验证命令并确认输出后才能声称成功；始终用证据支撑断言
- **workflow-runner**: 在 Claude Code / OpenClaw / Cursor 中直接运行 agency-orchestrator YAML 工作流——无需 API key，使用当前会话的 LLM 作为执行引擎。当用户提供 .yaml 工作流文件或要求多角色协作完成任务时触发。
- **writing-plans**: 当你有规格说明或需求用于多步骤任务时使用，在动手写代码之前
- **writing-skills**: 当创建新技能、编辑现有技能或在部署前验证技能是否有效时使用

## 如何使用

当任务匹配某个 skill 时，使用 `Skill` 工具加载对应 skill 并严格遵循其流程。绝不要用 Read 工具读取 SKILL.md 文件。

如果你认为哪怕只有 1% 的可能性某个 skill 适用于你正在做的事情，你必须调用该 skill 检查。
<!-- superpowers-zh:end -->

## 广告数据说明

### 数据表说明

ad 报告现在使用 `ad_upload_files` 体系（**正在使用**），取代了之前的 `analysis_source_files` ad_product_report 路径。

| 表名 | 用途 | 使用状态 |
|------|------|----------|
| `ad_upload_files` + `ad_upload_promoted_product_rows` | 亚马逊原始广告报表（按文件存储） | **正在使用** |
| `analysis_source_files` + `analysis_ad_product_rows` (ad_product_report 部分) | 旧的"分析"路径 | **已下线**（2026-06-01 alembic 152 删了 27,445 行） |

### 重要决策记录

**2026-06-01**: ad_product_report 数据从 A 表 (`analysis_source_files` + `analysis_ad_product_rows`) 完整迁移到 C 表 (`ad_upload_files` + `ad_upload_promoted_product_rows`)：
- 业务读取 10 个调用点已切换到 C 表（daily/ad, daily/analysis, product/ad, product/sources, product/_internal, scheduled_report/{daily,weekly}, digital_display_service, ai_insight_aggregator）
- 新数据入口（`commit_upload` 走 ad_product_report）已切到 C 表（不再写 A 表）
- A 表 ad_product_report 数据已删除（alembic 152）；CHECK constraint 移除 `ad_product_report` 防止未来误用
- `raw_row.__meta__` 保留迁移来源追溯 (`old_source_file_id`, `old_source_row_no`, `old_scope_status`)
- alembic 153 独立回填 scope_status 列（从 raw_row.__meta__ 提取），处理"加列时 0 数据"陷阱

**2026-05-22** (已撤销): `_build_ad_snapshot` 函数曾修改为从 `analysis_ad_product_rows` 查询广告数据。

原因（已失效）：当时 `ad_upload_` 仅项目4（玥涵）有数据，且数据日期为2026-03-26。其他13个项目数据维护在 `analysis_ad_product_rows` 表中。**该决策于 2026-06-01 被 ad_product_report 数据迁移到 C 表 取代**。

### 报告类型映射

- `ad_upload_promoted_product_rows` 对应 `AdUploadFile.report_type = 'ad_promoted_product_report'`
- 日期过滤使用 `AdUploadFile.report_date`（同 `period_end_date`，因为单日上传时相等）
- scope 过滤：`AdUploadPromotedProductRow.scope_status == 'included_product'`
