# Go 全栈迁移 Implementation Plan（Python FastAPI → Go API + Wails 桌面端）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `backend/`（Python FastAPI + Celery）完整迁移为 Go 后端（API 服务 + 后台任务），并用 Wails 交付原生桌面客户端，最终下线 Python 运行时。

**Architecture:** 新建顶层 `go/` 目录与旧 `backend/` 并存开发；Go 端按“共享领域包（`pkg/`）+ API 服务（`services/api`）+ 任务服务（`services/worker`）+ 桌面壳（`desktop/`）”分层；通过契约测试 + 影子流量验证行为一致后一次性切换流量，再下线 Python。

**Tech Stack:** Go 1.26 / Gin / sqlc / Asynq / gocron v2 / Rod / excelize / aws-sdk-go-v2 / Resend Go SDK / Wails v2 / golang-migrate（仅切换后新迁移）

## Global Constraints

- 所有 git commit 的 author email 必须是 `jr.way123@gmail.com`（BEL-153，否则 Vercel 拒部署），提交前跑 `git config --show-origin --get user.email` 自查。
- Commit 信息用中文 + Conventional Commits（`feat/fix/docs/test/chore…`），关联 issue 用 `Closes BLF-XXX`。
- 迁移期间 **绝不改 `backend/` 下任何生产代码**（只读参照），所有 Go 代码进 `go/` 新目录；pytest 一律走 `BLF_test` 库，绝不写 `BLF` 生产快照库。
- 公共函数 / route / schema 改动先用 CodeGraph（`codegraph query/callers/impact`）确认影响面，PR 描述写明用过的 CodeGraph 工具（BEL-93）。
- Alembic 迁移命名与单 head 规则在切换前继续有效；`go/` 内新增 SQL 迁移走 golang-migrate（见 Phase 4 基线冻结方案）。
- 主键统一 `Integer`（对齐现有模型 `Mapped[int]`），Go 端用 `int32`/`pgtype.Int4`，勿用 `BigInteger/int64` 做主键。
- 每个 Phase 结束必须通过其 Exit Criteria 才能进入下一 Phase；任何资金相关计算（定价/佣金/对账）必须双跑 diff 零差异。

---

## 现状快照（2026-09-03 实测，非估算）

| 指标 | 实测值 | 测量方式 |
|------|--------|----------|
| 后端生产代码 | **136,542 行**（`backend/app`） | `find + wc -l` |
| 后端测试代码 | 68,543 行（`backend/tests`） | 同上 |
| 脚本 / 迁移 / worker | 11,007 / 18,968 / 296 行 | 同上 |
| Python 文件总数 | 1,178 个 | `find -name "*.py"` |
| 路由装饰器 | **405 个**（GET 198 / POST 135 / DELETE 33 / PATCH 31 / PUT 8） | `grep @router.*` |
| API 文件 | 120 个（`backend/app/api`） | `find` |
| 数据模型文件 | 56 个（`backend/app/models`） | `ls` |
| Celery task 装饰器 | 21 个 | `grep @*.task` |
| Alembic 迁移文件 | 238 个 | `ls alembic/versions` |
| `iterrows()` 热点 | 18 处 / 23 个文件用 pandas | `grep` |
| 前端页面 | 84 个 `page.tsx`，Next 16.2.4 + React 18 + shadcn | `find` |
| 前端 dashboard 模块 | advertising / ai / crm / finance / operations / reports / system / tools / v1 … | `ls app/dashboard` |
| 本机 Go | go1.26.5 darwin/arm64 已安装；Wails 未安装 | `go version` |
| 生产环境 | 2GB VPS，4 个 systemd 服务（api / celery / celery-scheduled / beat） | `backend/deploy/systemd` |

> ⚠️ 注意：此前讨论中“55–70K 行 / 250+ 端点”是低估。**以本表实测为准**：生产代码 13.6 万行、405 路由。这意味着全量迁移工作量比此前估计上调约一倍，工期见各 Phase 估算。

## Phase 总览

| Phase | 文档 | 内容 | 预估（AI 辅助） | 前置 |
|-------|------|------|----------------|------|
| 0 | `…-phase0-foundation.md` | `go/` 工程骨架、工具链、CI、契约测试 harness 骨架 | 3–5 天 | — |
| 1 | `…-phase1-domain.md` | 共享领域包：定价引擎、库存算法、解析器、支付聚合、类目分析、告警检测 | 2–3 周 | P0 |
| 2 | `…-phase2-api.md` | Go API 服务：config/db/auth/中间件 + 405 路由分 10 组移植 | 3–4 周 | P1（领域包） |
| 3 | `…-phase3-workers.md` | Asynq 任务 + 调度器 + 报告管线 + Rod 截图 + 邮件 | 2–3 周 | P1 |
| 4 | `…-phase4-parity-cutover.md` | 契约全量 diff、影子流量、Alembic 基线冻结、切换 runbook | 1–2 周 | P2 + P3 |
| 5 | `…-phase5-wails.md` | 前端 API 抽象层 + Wails 桌面端打包分发 | 1–2 周 | P4（API 稳定后） |
| 6 | `…-phase6-decommission.md` | 下线 Python：systemd 替换、VPS 清理、仓库归档 | 3–5 天 | P4（P5 可并行） |

**总工期（AI 全力辅助）：8–13 周。** 瓶颈在 Phase 1/2 的业务逻辑验证（资金相关必须人工 review），不在代码生成速度。

## 关键架构决策（已定，执行中不再讨论）

1. **目录**：`go/` 顶层新目录，内含 `go.work` 或单 module `believeboy-go`；布局见 Phase 0。`backend/` 冻结为只读参照。
2. **ORM 策略**：`sqlc`（类型安全、手写 SQL、AI 生成可靠）为主；复杂动态查询用 `sqlx`。不用 GORM（隐式行为多，diff 难）。
3. **路由**：Gin（训练数据最多、AI 生成最稳）。10 个 lazy route group 原样映射为 10 个 Go package。
4. **队列**：Asynq（Redis-backed，语义最接近 Celery）+ asynqmon 监控。
5. **调度**：gocron v2 替代 Celery Beat + APScheduler（两套调度统一为一套）。
6. **Alembic**：切换前 Alembic 仍是唯一 schema 真源；切换时冻结 revision → `pg_dump --schema-only` 建 golang-migrate 基线 → 之后新迁移走 Go。176+ 历史迁移**不翻译**。（详见 Phase 4）
7. **截图**：Rod 为主；若 Rod 在某类报表 HTML 上渲染不一致，保留 50 行 Python sidecar 做 fallback（HTTP 调用），不阻塞主线。
8. **Excel/CSV 解析**：`excelize`（读）+ SQL `COPY`（批量写）替代 `iterrows()` 逐行 ORM 插入；这是内存优化的核心手段。
9. **LLM 调用**：标准库 HTTP + SSE 手写客户端（OpenAI-compatible），结构化输出用 `jsonschema` 校验；不引入重型 Agent 框架。`pydantic-ai` 的 tool 定义逐个翻译为 function-calling schema。
10. **桌面端**：Wails v2（stable，锁版本；Phase 5 启动时再评估 v3 是否已 stable）。前端 Next.js 构建产物嵌入 WebView，**前端业务代码不重写**。

## 风险登记

| # | 风险 | 等级 | 缓解（指向 Phase） |
|---|------|------|-------------------|
| R1 | 资金计算（定价/佣金/对账）翻译精度 bug | 🔴 高 | Phase 1 双跑 diff + 人工 review；Phase 4 全量回归 |
| R2 | pandas 语义（NaN/时区/Decimal）与 Go 行为差异 | 🔴 高 | Phase 1 建 `docs/` 语义对照表 + 边界用例库 |
| R3 | Rod 截图与 Playwright 像素不一致 | 🟡 中 | Phase 3 像素 diff 阈值（<1%）+ Python sidecar fallback |
| R4 | 405 路由一次性切换风险 | 🔴 高 | Phase 4 按 10 组灰度 + 影子流量先行 |
| R5 | AI 生成 Go 代码风格漂移（多 agent 并行） | 🟡 中 | Phase 0 锁 `golangci-lint` + 统一错误处理/日志规范 |
| R6 | 工期超预期导致双栈维护期拉长 | 🟡 中 | 每 Phase 独立可交付；P6 之前 Python 照常部署 |
| R7 | Next.js 内嵌 Wails 后 auth/cookie 行为变化 | 🟡 中 | Phase 5 用 token 注入替代 cookie，见该 Phase |

## Self-Review（2026-09-03）

- [x] Spec 覆盖：后端 405 路由 / 56 模型 / 21 task / 截图 / 邮件 / R2 / LLM / 桌面端，每个都有对应 Phase 任务。
- [x] 数字全部来自本机实测命令输出，非早期估算；与早期估算的差异已在快照中显式标注。
- [x] 无占位符：各 Phase 文件含确切源文件路径、目标路径、验证命令。
