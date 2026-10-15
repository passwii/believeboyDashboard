# 仓库深度参考（Reference）

> 本文件是**深度参考**，不被 ZCode 自动读取。指令性内容（CodeGraph / 测试 / 提交 / 部署规则）见 [`AGENTS.md`](../AGENTS.md)；`CLAUDE.md` 已弃用为薄壳。

---

## 业务模块说明（Business Modules）

- [库存补货分析](./库存补货分析.md)：库存健康、补货与清货动作的判定边界。
- [发货规划](./发货规划.md)：未来 180 天的供给情景模拟与销售上限；与正式货件管理分离（BLF-1284 实施中）。

## 架构（Architecture）

### Frontend → Backend 通信
前端**绝不直接连 PostgreSQL**。所有后端调用经 Next.js API 路由代理 `frontend/app/api/backend/[...path]/route.ts`，转发到 `BACKEND_API_BASE_URL`（默认 `http://127.0.0.1:8100`），带 `X-API-Key` / `X-User-Id` / `X-User-Name` / `X-Operator` / `X-Is-Admin` 头。后端在 `app/core/security.py` 校验 `X-API-Key`。

### Backend API
- 入口：`backend/app/main.py`；路由聚合：`backend/app/api/v1/router.py`
- Endpoint 模块：`backend/app/api/v1/endpoints/`（auth, users, projects, product_costs, exchange_rates, daily_reports, monthly_reports, product_analysis, daily_analysis, ad_analysis, ad_upload, inventory_replenishment, shipping_plan, pricing_calculation, store_accounting, shipment_schedules, store_sku_pricing_snapshots, category_research, report_upload, ai_chat, ai_file_upload, ai_insight, jobs, uploads, system_management, presence, health, return_analysis, project_goals, rpa_reports）
- Services：`backend/app/services/`（每资源一个文件）；Models：`backend/app/models/`；Schemas：`backend/app/schemas/`；DB session：`backend/app/db/session.py`
- 对外 API：只读 external 现状见 `backend/docs/external-api.md`；面向 Agent 的读写 API（`/api/v1/agent/*`，替代 external）设计与实施规格见 [`docs/agent-api-design.md`](./agent-api-design.md) + [`docs/superpowers/specs/2026-08-04-agent-readwrite-api-spec.md`](./superpowers/specs/2026-08-04-agent-readwrite-api-spec.md)

### Frontend 结构
- `frontend/app/dashboard/` — 页面（App Router）：`ai-panel/`、`ai-insights/`、`operations/`、`data-reporting/`、`data-analysis/`、`data-management/`、`system-management/`、`tools/`、`changelog/`
- `frontend/components/dashboard/`、`frontend/components/ui/`（shadcn）、`frontend/components/notifications/`
- `frontend/lib/` — 工具、auth、backend 代理；`frontend/app/api/backend/[...path]/route.ts` — 代理所有后端调用

### Auth
- 前端：NextAuth.js v4（`frontend/app/api/auth/[...nextauth]/route.ts`）
- 后端：`require_api_key`（`app/core/security.py`）校验 `X-API-Key`；除 `/api/v1/health` 外全保护；请求级用户上下文来自 `X-Operator` / `X-User-Id`

### Background Jobs
Celery worker 基于 Redis broker 运行。当前两个 systemd 单元：
- `believeboy-celery.service`（`-c 4`，消费 `default,reports,insights,ai_summary`）——手动月报 + AI 洞察 + 定时报告 AI 摘要
- `belief-worker-scheduled.service`（`-c 2` BEL-NEW，仅消费 `scheduled`）——定时报告主体（数据 / 截图 / 邮件），方案 `2026-07-10-scheduled-report-to-celery.md §4.4`

APScheduler 仍跑在 API 进程内，每分钟扫订阅触发派发。但调度本身退化成"定时器"——派发延迟通过 Celery `apply_async(countdown=i*SCHEDULED_DISPATCH_SPREAD_SECONDS, ...)` 错峰，主体任务跑在 worker。`SCHEDULED_REPORT_VIA_CELERY=false` 可回到 ThreadPoolExecutor 同步派发形态（秒级回滚，不动代码）。监控面板 Flower 已移除（冗余——任务状态走 Job 表 + 前端轮询，运维见 `backend/docs/multi-worker-ops.md`）。

### autoReportUpload
独立 Python 服务（`autoReportUpload/`），监控目录自动识别并上传报表到后端，**不**直连 PostgreSQL——持久化走 FastAPI 内部端点 `/api/v1/internal/auto-report/{recognize,ingest,heartbeat}`，鉴权 `X-Internal-Token`（`INTERNAL_INGEST_TOKEN`）。改 schema / ingest 只动 `backend/app/services/internal_ingest.py` + `backend/app/schemas/internal.py`。

```bash
cd autoReportUpload && source ../backend/.venv/bin/activate
python run.py            # 周期循环
python run.py --dry-run  # 只识别不写库
python run.py --once     # 单次扫描
```

### AI Chat
外部 AI provider（env `AI_CHAT_PROVIDER_*`），联网搜索 `AI_CHAT_WEB_SEARCH_*`；历史存 `AIConversation` / `AIMessage`；`ai_insight` 端点提供 AI 数据洞察。

---

## 部署与重启服务（Deployment）

> 本机服务用 **systemd** 管理。让线上生效**不要直接 `pkill`**，走 `systemctl restart`。

### 服务清单（仅后端）
| Unit | 进程 | 监听 |
|---|---|---|
| `believeboy-api.service` | `uvicorn app.main:app` | `0.0.0.0:8100`（OpenAPI 在 `/docs`） |

> 本 VPS 只部署后端。前端在 Vercel / 外部平台，生产环境变量在平台 dashboard 配置（非 `frontend/.env.local`）。前端构建现已可在本地 / CI / VPS 跑（`pnpm -C frontend build`），但部署目标仍是外部平台。

### 常见操作
```bash
systemctl status believeboy-api.service
sudo systemctl restart believeboy-api.service   # 改 backend 代码必跑
sudo journalctl -u believeboy-api.service -n 50 --no-pager
curl -s -o /dev/null -w 'api %{http_code}\n' http://127.0.0.1:8100/docs
# 改 backend 涉及 DB schema → 先 alembic upgrade head 再 restart
```

### 为什么不要 `pkill uvicorn` / `pkill next`
systemd 会拉起新进程但可能读旧代码 / 旧 `.env`、撞端口，进入 `activating (auto-restart)` 死循环。`systemctl restart` 按 unit 顺序 SIGTERM → 等 `TimeoutStopSec` → `ExecStart` 新进程，端口由 systemd 接管。

### Mac 本地开发（launchd）
仓库根 `deploy/launchd/`（Mac 对应物；前端在 Vercel 不起 web）。**DB 现走本地生产快照**（`localhost:5432` 的 `BLF`，BEL-376 起常驻；详见 [TESTING.md](../../TESTING.md#本地生产快照库bel-376-集成--手动读写测试)），`backend/.env` 的 `DATABASE_URL` 已指向它；旧方案曾走远程 VPS（`145.79.143.98:5432`）。改代码一律 `deploy/launchd/bin/restart.sh`。

### 已知坑
- `ss -ltnp` 在沙箱看不到非自己用户的 socket，用 `journalctl -u <unit> -n 5` + `ps -ef | grep` 双确认。
- 重启后探活用 `curl /docs`（项目**无** `/health` 路由，404 正常）。
- BFF 路由 404 通常漏 `pnpm build`（`app/api/.../route.ts` 改后必须 build）。

---

## 环境变量（Environment Variables）

**Frontend**（`frontend/.env.local`，Mac 本地）：`BACKEND_API_BASE_URL`、`BACKEND_API_KEY`、`NEXTAUTH_URL`、`NEXTAUTH_SECRET`。

**Backend**（`backend/.env`）：`API_KEY`（须匹配前端 `BACKEND_API_KEY`）、`UPLOAD_ROOT` / `RESULT_ROOT` / `MAX_UPLOAD_BYTES`、`AI_CHAT_PROVIDER_*`、`AI_CHAT_WEB_SEARCH_*`、`REDIS_*`（可选，presence 用）。
> 注（BEL-376 更新）：`backend/.env` 现已**直接写入** `DATABASE_URL`，指向本地生产快照 `postgresql+psycopg://damon:<pw>@localhost:5432/BLF`（旧值曾误指向死端口 `55432`；更早的本地开发曾直连远程 VPS `145.79.143.98:5432`，均已弃用）。`TEST_DATABASE_URL` 仍在 `backend/.env.test`（gitignored）→ 本机 `brew` Postgres 的 `BLF_test`，供自动化 pytest / Playwright 隔离用（见 [TESTING.md](../../TESTING.md#本地服务mac--brew)）。

---

## 数据库与迁移（Database）

PostgreSQL only，无 SQLite 回退。模型在 `backend/app/models/`，迁移用 Alembic。

**迁移命名**：`YYYYMMDD_NNN_description.py`（`NNN` 为三位序号，从最新迁移递增，如 `121`、`122`，不从 1 重计）。
**Revision ID**：纯数字短 ID（`'131'`），严禁长格式 / 随机 hash；严禁改已运行迁移的 `revision`；`down_revision` 指向前一短 ID，保持单链。

```bash
cd backend && ls alembic/versions/ | grep "^2026" | sort | tail -5
cd backend && .venv/bin/alembic heads
```

**多 worktree 并行迁移流程（防撞 + 不抢跑 prod）**：

迁移碰撞的根因是"建迁移时 `down_revision` 选错"，不是 merge 时机。因此核心是**建前先同步 main 取单链**，而非"建完立即合 main"（立即合会让 schema 先于业务代码上 prod——`git deploy` 命中 `backend/` 即自动 `alembic upgrade head`，易造成列与代码错位）。

1. **建迁移前（强制防撞）**：先同步 main 并确认单链，再以此 head 为 `down_revision`：
   ```bash
   git fetch origin && git rebase origin/main   # 或 merge
   cd backend && .venv/bin/alembic heads         # 必须只有一个 head
   # 然后才 alembic revision --rev-id <下一序号> -m "<中文说明>"
   ```
2. **建完随 feature 分支走**：迁移文件和用它代码同批 review、同批合 main，避免 schema 裸奔提前触发 prod 部署。
3. **真撞了（出现两个 head）**：在 main 侧 `alembic merge heads --rev-id <下一序号> -m "merge xxx"` 合回单链（见下）。
4. **其他 worktree 要用迁移**：先 rebase/pull main 拿到最新单链，再重复步骤 1。

**机械强制检查（BLF-492）**：`backend/scripts/check_alembic.py` 在 push / 部署前自动跑（git deploy、pre-push hook、VPS deploy 的 `alembic upgrade head` 之前），检查：单 head、文件名 `YYYYMMDD_NNN_...` 且 revision id 纯数字（兼容历史日期风格 `20260718_214`）、无重复 id、无孤儿/坏链。失败会阻断 push / 部署并给出 `alembic merge heads` 修复提示；历史遗留违规文件在白名单 `LEGACY_EXCEPTIONS`（只减不增）。手动运行：`cd backend && python scripts/check_alembic.py`。

---

## 广告数据说明（Ad Data）

ad 报告现用 `ad_upload_files` 体系（**使用中**），取代旧 `analysis_source_files` + `analysis_ad_product_rows` 的 ad_product_report 路径（**已下线**：2026-06-01 alembic 152 删 27,445 行）。

- `ad_upload_promoted_product_rows` 对应 `AdUploadFile.report_type = 'ad_promoted_product_report'`
- 日期过滤用 `AdUploadFile.report_date`（单日上传 = `period_end_date`）
- scope 过滤：`AdUploadPromotedProductRow.scope_status == 'included_product'`

**决策记录 2026-06-01**：ad_product_report 从 A 表完整迁移到 C 表（`ad_upload_files` + `ad_upload_promoted_product_rows`）；10 个业务读取调用点已切换；新入口走 C 表；A 表数据已删，CHECK constraint 移除；`raw_row.__meta__` 保留迁移来源追溯。

---

## PR 把关流程（完整）

> **本节是 PR 把关的权威章节。** `AGENTS.md` §PR 把关流程（Codex-first）是它的摘要，冲突以本节为准。

### 角色与门禁边界

- **作者**：前端 / 后端 agent（Seth / Damon）——提 PR、按 `AGENTS.md` §测试规则跑分档测试、写测试声明、交棒。
- **把关人**：代码质量工程师 Tia——读 Codex 结果、变更面识别、必需门禁，决定合并 / 退回 / 升级用户拍板。
- **合并动作只属于把关人**；作者（包括收到把关报告后）不得自己 `gh pr merge`。

### 作者侧：PR 正文只要求这几项

按 [`.github/pull_request_template.md`](../.github/pull_request_template.md) 填：

1. **关联 Issue**：`Closes BLF-XXX`（保证 webhook 链接回 issue）；
2. **变更与影响面**：改了什么、影响哪些模块；涉及公共函数 / hook / route / service / schema 时写明 CodeGraph `callers` / `impact` 结论（fallback 到 Read/Grep 要说明原因）；
3. **风险等级**：`[risk:normal]` / `[risk:high]`（高风险 = DB 迁移 / 权限认证 / 支付资金 / 外部 API 契约变更 / 删除性操作 / 跨模块大重构）；
4. **实际执行的验证 + 真实数字**：按 T0–T3 分档，逐条写命令与结果（`errors / warnings / passed / failed`）；**没实际跑过的命令禁止打 ✓**；
5. **未执行项及原因**：例如 `pnpm build` 交 Vercel preview、无相关改动故未跑 Playwright；
6. **迁移 / 部署说明**：涉及迁移时给 `check_alembic.py` 结果与部署注意事项。

提交自检：commit author email = `jr.way123@gmail.com`（BEL-153，否则 Vercel 拒部署）；diff 无 `TODO` / `FIXME` / `console.log` / `debugger` 残留。CodeGraph 不再是「每个 PR 必填项」，只有改动公共符号时才需要给影响面结论（BEL-93 的本意）。

### 把关人侧：Codex 自动审查怎么判

Codex（`chatgpt-codex-connector`）自动审查是**低风险 PR 的主要语义 review 来源**，但只覆盖「静态语义 review」这一件事。

**四个来源都要读，结论必须落在当前 PR HEAD，未结 finding 例外**（`passwii/believeboyDashboard`，`<N>` = PR 号）：

| 用途 | 读取命令 | 关键字段与判定 |
| --- | --- | --- |
| HEAD / 文件 / 检查概览 | `gh pr view <N> --json number,state,headRefOid,files,latestReviews,statusCheckRollup`；必需检查另跑 `gh pr checks <N> --required` | `headRefOid` = 当前 HEAD。`latestReviews` 与 `statusCheckRollup` **只是概览、不是全量**：前者每个 reviewer 只保留最新一条，后者只给聚合结果、**不区分该检查是否必需** |
| Codex review | `gh api --paginate repos/passwii/believeboyDashboard/pulls/<N>/reviews` | `user.login`、`state`、`commit_id`、`body`、`submitted_at` |
| Codex 行内问题 | `gh api --paginate repos/passwii/believeboyDashboard/pulls/<N>/comments`；thread 是否已结用下方 GraphQL | `user.login`、`body`、`path`、`line`（已过期评论看 `original_line`）、`commit_id`、`in_reply_to_id` |
| Codex 摘要 / 完成状态 | `gh api --paginate repos/passwii/believeboyDashboard/issues/<N>/comments` | Review Summary 表的 Status + Commit + trigger；`👍` 反应只作辅助信号 |

**三个集合端点必须带 `--paginate`**：`gh api` 默认每页 30 条且**只返回第一页**（`gh api --help`：`--paginate` 会继续请求后续页）。审查记录超过一页时，Review Summary 可能已 `Completed`、而后一页的 inline finding 读不到 → 假 `CLEAN`。`gh pr view --json latestReviews` 同理不是全量（每个 reviewer 只留最新一条），**不能只靠它得出「无发现」**。

**判断「跨 head 的旧 finding 是否仍挂着」**：REST 不暴露 thread 的 resolve 状态，用 GraphQL：

```bash
gh api graphql -f query='{ repository(owner:"passwii", name:"believeboyDashboard") { pullRequest(number:<N>) { reviewThreads(first:100) { nodes { isResolved isOutdated path line comments(first:5) { nodes { author { login } commit { oid } } } } } } } }'
```

`isResolved=false` 的 thread 就是**未结 finding**；`isOutdated=true` 只说明评论挂在旧 diff 行上，**不等于问题已修**。

**必需检查不能用 `statusCheckRollup` 推断**：rollup 只列聚合结果，不区分必需与可选（该仓库 main 上 `gh pr checks <N> --required` 实测为空，即 branch protection 未把 Vercel 等设为必需）。判断必需门禁用 `gh pr checks <N> --required`，或直接查 branch protection / ruleset；Vercel 部署检查在本仓库属**项目约定门禁**，不因它不是 branch-required 就跳过。

**为什么四个都要读（BLF-1345 实录）**：PR #720 的 Codex Review Summary 写明 `✅ Completed`，而真正的 P1（跨操作员项目数据访问越权）**只出现在 inline review comment**；只读 `gh pr view` 摘要或只看 summary 评论会漏掉它。

**这套流程自身被 Codex 审出的三个边界（PR #726）**：① 集合端点漏 `--paginate`（只能读到第一页，后页 finding 静默丢失）；② 未结 finding 不跨 head 结转（推个新 commit 就能让旧 P1 从门禁消失）；③ 用 `statusCheckRollup` 推断必需检查（把可选检查当必需门禁）。三条均已并入上面的命令与枚举，照本节执行即可。

**决策枚举**：

- `PENDING`：Codex 仍在审查，或当前 HEAD 尚无完成记录 → 不合并；未观察到对新 HEAD 的完成记录时显式请求 `@codex review` 并等明确完成。
- `UNKNOWN`：GitHub API / 权限 / 网络失败、review commit 无法确认、多个来源互相矛盾 → 报告原因并回退人工 review，**不得静默降级为 `CLEAN`**。
- `FINDINGS`：**任一来源**（含行内评论）提出尚未处理的真实风险 → 逐条判断有效性，真实问题修复或经人工明确接受后才继续。判定范围**不限于当前 HEAD**：早于当前 HEAD 的未结 inline finding（`isResolved=false`）**继续算 finding**，直到其 thread 被 resolve、或经人工明确 dismiss 并记录原因——作者推一个无关 / 不完整的新 commit **不会**让旧 P1 消失（那一刻它就是「已知未修」，不是「已过期」）。同时，当前 HEAD 仍必须有一份完成记录，否则先按 `PENDING`。
- `CLEAN`：已确认 Codex 对**当前 HEAD**完成、四个来源均已读、**且不存在任何跨 head 未结 finding**——**仍需**满足该 PR 适用的必需检查与测试策略。

**Codex 之外仍然必须的**：

- **Codex ≠ 测试**：静态审查不能证明代码跑得起来，也不替代作者测试证据、既有必需 GitHub 检查 / 前端 Vercel 门禁与部署检查；
- **缺陷修复后**：按影响面跑对应目标集；Codex 未自动重审新 HEAD 时显式 `@codex review`，**旧 commit 的结论不能放行新 HEAD**；
- **T3 不因 Codex 无发现而跳过**：命中 §测试规则（完整）的 T3 条件（迁移 / 权限 / 公共 schema / `app/core/config.py` 字段等）时仍按原规定验证；
- **高风险 PR**（见上方风险等级定义）仍升级用户拍板，不因 Codex clean 自动合并。

### 简化了什么、没简化什么（BLF-1345）

- **简化**：低风险 PR 不再逐项人工 review、不再无差别全量本地测试；PR 正文只填上面 6 项；CodeGraph 从「每个 PR 必填」降为「改公共符号时填影响面结论」；Review agent 与作者 agent 的 instruction 不再重复维护整套流程（只指向本仓库文档）。
- **没简化**：commit author 约束、关联 Issue、真实测试数字、必需 GitHub 检查 / Vercel 门禁、T3 与高风险验证、合并归属把关人。


---

## 测试规则（完整）

> **本地数据库（BLF-472）**：所有前后端测试都调用**本地数据库**完成，不依赖远程 VPS——本地 Postgres（端口 5432）常驻 `BLF`（生产快照，每日与生产拉取同步，数据完备，供集成 / 手动读写 / 真实数据验证）与 `BLF_test`（pytest 隔离库）。pytest 一律走 `BLF_test`，绝不写 `BLF`。详见 [TESTING.md](../../TESTING.md)。

每次前端/后端开发后仍走两轮测试（技术 + 业务），但技术测试**按变更面分流**、不默认全量：

**规则 1 技术测试（按变更面分流，不默认全量）**

表格场景用于初步归类；若与下方条件冲突，按更高档执行。判档命中任一 T3 条件即升 T3：① 改动跨模块复用的公共符号、共享契约或其行为（用 CodeGraph `callers` / `impact` 确认影响面）；② 改动迁移或权限逻辑；③ 改动 `app/core/config.py` 的配置字段 / 默认值，或 `app/models/*`、`app/schemas/*` 的字段、约束、序列化契约。仅注释 / 文案改动不因此升档。字段级改动对目标集不可见，因此相关行为改动必须全量验证。

| 档 | 场景 | 后端 | 前端 |
| --- | --- | --- | --- |
| **T0** | 只改 `docs/`、注释或文案，且不改变运行行为 | 不跑 | 不跑 |
| **T1** | 叶子改动：单个工具函数 / 单个组件，仅影响局部实现，未触发 T3 条件 | 目标文件（~8s） | `vitest run <该文件/目录>`（~10s） |
| **T2** | 局部功能：新增端点 / 新页面，未触发 T3 条件 | 目标集 + 该目录回归 | Vitest 目标用例 + 该目录回归 + `pnpm lint` |
| **T3** | 跨模块 / 高风险：公共 hook、schema、model、**迁移**、权限、共享 utils | **全量（单次；耗时以当次实测为准）+ 失败集对账** | 全量（BLF-1238 已修好：235 文件 / 1660 例 / **~43s**，同机满载约 2 分钟）+ lint；build 交 Vercel |

**E2E 不按 T 档一刀切：** 涉及登录、权限隔离、NextAuth、前后端代理或关键跨服务用户流程时，跑对应 Playwright 用例；纯业务逻辑 / API 行为优先用 pytest 覆盖，不为凑档位盲目跑 E2E。运行前按入口文档准备测试数据库和前后端服务：前端见 [TESTING.md](../TESTING.md)，后端见 [agent_testing README](../backend/scripts/agent_testing/README.md)。前端命令：`cd frontend && pnpm test:ui -- tests/<area>/<name>.spec.ts`；后端 agent E2E：`cd backend && pytest scripts/agent_testing/<test_file>.py -v`。

**为什么第 ③ 条旋钮要单列**：字段级改动对目标集天然不可见。BLF-1237 把 `avatar_max_bytes` 并进了上一行注释，`Settings` 丢字段、生产头像上传 500，而目标集 64 例全绿；且因 main 上同批用例本来就失败（R2 未配置），**失败集合一模一样，回归被完全掩盖**——只有全量跑才暴露。

**前端铁律（BLF-1238 后更新）**：T1/T2 **优先带路径过滤**（`vitest run <路径>`），但**全量 `pnpm test` 已可裸跑**——235 文件 / 1660 例 / **~43s**（本机较空闲）～**~2 分钟**（同机其他 agent 满载，实测 59s / 79s / 124s），T3 才需要。`pnpm build`（30-90s）仍可交 Vercel，本地按需。判「挂住」不看绝对秒数，看是否在推进（见下条）。

**卡住判型（BLF-1238 教训）**：跑到 60s 仍无 `Test Files` 汇总 + 某 worker 长时间 100%+ CPU = 某文件**无限渲染循环**（不是「慢」）；`--testTimeout` / `vi.waitFor` 救不了（微任务链饿死计时器，表现为永久挂起而非超时失败）。二分与根因规则见 [TESTING.md](../TESTING.md) §前端单测。

**失败集对账（替代基线全量）**：PR 上全量只跑一次并记录失败项；仅对 main 上存在的失败用例文件，在相同命令 / 环境下对账一次，不再跑第二遍全量。PR 与 main 出现相同失败时，记录为既有失败，不误报为本次回归；新增用例无法在 main 对账，需单独复现。若失败不稳定，只定向重跑失败用例确认并记录；修复本次引入的问题，不用 `skip` / `xfail` 隐藏失败。BLF-1237 那轮 26 个既有失败只落在 8 个文件上，对账 10 秒，省掉一整轮 6 分钟。

**后端 T3 为什么不能省全量**：仓库**没有后端 CI**（`.github/workflows` 只有 `cache-governance` / `lighthouse-ci` / `motion-system-ci`），本地全量是唯一信号源。耗时受环境、测试库和收集情况影响，不提供固定时间估计。
若遇到 [backend/tests/README.md](../backend/tests/README.md) 记录的 `PROD_DATABASE_URL` 导入期收集失败，视为测试收集阻塞、不能报全绿；记录具体错误并修复或隔离导入链后再确认覆盖。

**不要用 `pytest -n auto`**：共享 `BLF_test` 上 `tests/api/crm/conftest.py` 的 autouse `TRUNCATE ... RESTART IDENTITY CASCADE` 会让 worker 互相死锁（`psycopg.errors.DeadlockDetected`，实测 225 failed / 155 errors）。曾有一次 10 worker 运行在 5 分 02 秒后因错误提前退出（380 例未完成）；该次结果不能作为有效全量耗时或性能对比。要用并行测试，先做每 worker 独立库，另开任务。

- 前端命令：**按上表选要跑哪条，不是固定顺序**——`vitest run <路径>`（Vitest 单测，T1/T2 主力）、`pnpm lint`（2-5s，T2/T3）、`pnpm build`（30-90s，可交 Vercel）。
- 后端命令：`cd backend && pytest`（单个 `pytest tests/path/to/test_file.py::test_name`）。新增失败立即修；确认是基线既有失败的，按上面的失败集对账规则记录，不误报为本次回归。
- 前端单元测试已放开：Vitest（jsdom，配置 `frontend/vitest.config.ts`），`*.test.ts(x)` 放单元断言，组件交互用 `@testing-library/react`；新建纯函数 / 工具模块优先补单测。

> **实测数字口径**：本节引用的 420s / 900s、225 failed / 155 errors、380 例、26 个失败落在 8 个文件、对账 10 秒等，均为 **Damon 本机（macOS）2026-10-05 / 10-06 单次实测**，只用于说明量级与相对关系，**不是通用基准**；换机器 / 换分支 / 换库后请以当次实测为准。其中 420s / 900s 是 **BLF-1238 修复前**的前端挂起现象记录（已定位并修复，当前前端全量约 **43s 起、同机满载约 2 分钟**，2026-10-06 实测）。后端并行测试的耗时比较中，**6 分 42 秒是串行基准，5 分 02 秒是 10 worker 的失败试跑**；失败试跑有 380 例未完成，因此这组数据不能作为有效性能对比，失败试跑也不能视为全量结果。

**与 PR 把关的关系**：普通 PR 默认信任作者测试声明（PR 正文里的真实数字）+ Codex 完成结果，不机械重跑全量；命中 T3 条件、作者声明与门禁结论矛盾、或 CI 覆盖不到的边界（Lighthouse / mobile Playwright）才抽验——详见 §PR 把关流程（完整）§把关人侧。

**规则 2 业务测试（每次必做）**：功能完成后 AI 提供业务测试清单，用户手动执行并反馈。

**规则 3 反馈循环**：bug → 修复并重跑两轮测试；建议 → 记录评估。

### 如何向 AI 反馈
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

## Git 提交与部署

### 提交规范
中文 + Conventional Commits：`<type>(<scope>): <subject>`。type 保留英文（feat/fix/docs/test/chore/refactor/perf/style/ci/revert），scope/subject 中文，subject 动宾短语 ≤50 字无句号，正文中文。详细见 `chinese-commit-conventions` 技能。

### Workflow
- 推送前：按 §测试规则 的分级跑（**不默认全量**）；前端 T1/T2 优先带路径过滤，全量 `pnpm test` 已可裸跑（BLF-1238 已修，~43s 起）；后端 T3 才跑全量并做失败集对账。
- 推送 + 部署（2026-10-15 起）：**用 `git deploy` 推送，部署由 GitHub Actions 执行**。
  - `productEnvAgent/deploy.sh`（本地，`git deploy`）做两件事：① 校验在 main 分支；② `backend/` 改动时先跑 `backend/scripts/check_alembic.py` fail-fast，然后 `git push origin main`。**不再本地直连 SSH 部署**。
  - `.github/workflows/deploy-vps.yml`（CI，push 到 main 后触发）做部署：先 `git diff --name-only ${{ github.event.before }} ${sha}` 判定是否命中 `backend/`（与 `deploy.sh` 同口径），命中才 runner 从公网 SSH `root@145.79.143.98` 跑 `python productEnvAgent/deploy_vps.py --auto`；`concurrency: vps-deploy` + `cancel-in-progress: false` 保证同一时间只有一条部署路径、排队不取消。
  - 为什么搬出本地：本机 IP 可能被 fail2ban 拦、机器可能不在线；push 与部署解耦后，本地网络故障不会再造成"代码上了 main、VPS 未更新"。

> **只推代码不部署 / 跳过本次部署**：commit message 带 `[skip ci]`（GitHub 内建跳过，workflow 整个不跑）。
> - **查看进度 / 手动触发 / 只预览**：`gh run list --workflow deploy-vps.yml --limit 3` / `gh workflow run deploy-vps.yml` / `gh workflow run deploy-vps.yml -f dry_run=true`
> - **本地兜底部署（CI 不可用时）**：`LOCAL_DEPLOY=1 git deploy`，或直接 `python productEnvAgent/deploy_vps.py --auto`（需本机 SSH 可达 VPS）
> - **CI 需要的 secrets**（repo: `passwii/believeboyDashboard`）：`VPS_SSH_KEY`（能登录 root 的私钥，写到 runner 的 `~/.ssh/id_ed25519`，`deploy_vps.py` 走系统 ssh 默认私钥名）、`VPS_HOST`、`VPS_KNOWN_HOSTS`（不配则退化 TOFU）。设置：
>   ```bash
>   gh secret set VPS_HOST --repo passwii/believeboyDashboard --body 145.79.143.98
>   gh secret set VPS_SSH_KEY --repo passwii/believeboyDashboard < ~/.ssh/id_ed25519
>   gh secret set VPS_KNOWN_HOSTS --repo passwii/believeboyDashboard \
>     --body "$(ssh-keygen -F 145.79.143.98 | grep -v '^#')"
>   ```
>   建议后续改成 CI 专用密钥（并在 VPS 的 `authorized_keys` 加 `restrict` 选项）而不是个人密钥；轮换方式：把新公钥用一次 workflow 的 SSH 通道追加到 VPS，再替换 `VPS_SSH_KEY`。
> - **部署失败怎么办**：workflow 在 step summary 打出 bad-sha 与回滚命令（因为 `productEnvAgent/logs/last-failed-deploy.json` 落在 runner 临时磁盘上，本地 `rollback.py --auto` 取不到），按 `productEnvAgent/ROLLBACK.md` 用 `--bad-sha <sha>` 回滚；重跑部署用 `gh workflow run deploy-vps.yml`。
> - **新机器首次配置**：`git config alias.deploy '!bash productEnvAgent/deploy.sh'`

### Key Conventions
- **Projects API**：前端取项目列表用 `/api/v1/projects/manage`（非 `/api/v1/projects`）——`/manage` 按 `X-Operator` 过滤可见项目。
