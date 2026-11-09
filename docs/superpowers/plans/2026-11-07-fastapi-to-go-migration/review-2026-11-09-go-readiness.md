# Go 后端就绪度审核（PR #809 合入后）

> 审核日期：2026-11-09
> 审核基线：`main` @ `43e380ce`（PR #809 `feat(后端): 迁移 FastAPI 路由主体至 Go` 已合入）
> 审核方式：代码只读审阅 + 独立复跑门禁 + 运行期行为实测（chi 路由/挂载语义、测试用例复现）
> 审核范围：`backend-go/` 全部 666 个 Go 文件（约 24.4 万行）、`deploy/` 部署配置、`backend/` FastAPI 对照实现
> 结论：**不可切流、不可下线 FastAPI**（与 PR #809 自身的终审结论一致，但缺口比 PR 描述更多、且部分更严重）

---

## 1. 结论摘要

PR #809 把自己判定为「FAIL（不可部署）」，本次审核逐条复核后结论一致，并补充了 PR 未列出的问题。

| 判断 | 结论 | 关键证据 |
| --- | --- | --- |
| Go 代码是否「写完」 | **HTTP 域基本写完，是真实现不是空壳** | 抽查 12 个域全部真实读写数据库；52/52 张表名在 Alembic 迁移中真实存在 |
| 能否全量切流 | **不能** | 笼统地在 `GO_API_OWNED` 多开一个 Agent 模块就会在启动期 panic（P0，已实测） |
| 能否下线 FastAPI | **不能，且差距很大** | 生产 compose 无 `go-worker` / `go-scheduler`；异步任务 2 个空壳 + 2 个动态调度源缺失；PDF / Playwright / Alembic 仍为 Python 独占 |
| 线上实际接管比例 | **≈ 2.7%（17 条路由）** | `deploy/deploy-remote.sh` 硬编码 `GO_API_OWNED=health,exchange_rates,notifications,alerts,profile` |
| 门禁可信度 | **本机不能复现「全绿」** | `go test ./...` 在 Windows 上 4 包 12 例失败；`internal/store` 真库集成套件需 `GO_API_TEST_DATABASE_URL`，未设置时 `t.Skip`（CI 的 `live contract` job 另有真库覆盖，见 §3.4 第 2 条） |

一句话：**代码质量高于预期，证据链低于切流要求。** 差的不是代码量，是运行期证明、异步体系与 Python 独占能力。

---

## 2. PR #809「已知缺口」逐条复核

| # | PR 原描述 | 复核结论 | 证据 |
| --- | --- | --- | --- |
| P0 | `agent`、`agent_commerce`、`agent_credentials` 同时启用时重复 Mount `/api/v1/agent`，可导致 gateway 启动 panic | **仍存在，且范围更大：任意两个同时启用即 panic**（实测 4 种组合全部 panic，仅单模块正常） | 三处 `router.Route("/api/v1/agent", …)`：`internal/api/agent/registrar.go:39`、`agent_commerce/registrar.go:48`、`agent_credentials/registrar.go:42`；chi v5.5.0 `mux.go:295-304` 命中已存在 pattern 即 panic；`cmd/gateway/dependencies.go:483-526/552-566/634-650` 三个独立 `if`，无互斥校验 |
| P1 | AI Insight run-now 会重复创建 insight | **仍存在，机制比描述更糟：一次点击建 2 条，返回前端的那条永久 `pending`** | `internal/api/ai_insight/handler.go:494-500` 先插行再带 `ScheduleID+InsightID` 入队；`internal/tasks/tasks_external.go:49-80` 优先 `ScheduleID` 并丢弃 `InsightID`；`internal/store/ai_insight_schedule.go:400-461` 无幂等键/无 pending 去重/无 `is_active` 校验 |
| P1 | scheduled report worker executor 未装配；enqueue 位于 DB commit 前 | **两半都成立** | `HandlerConfig.Executor` 在 `cmd/worker/main.go:106-131` 从未赋值；`internal/tasks/handler.go:255-257` 返回 `ErrExecutorNotConfigured`，而 `dispatch_one` / `generate_delivery_summary` 已注册 → 每次执行必失败；`internal/api/scheduled_reports/handler.go:501-547,597-644,702-741` 三处 `Enqueue` 在 `RunInTx` 回调内 |
| P1 | Go scheduler 缺动态 insight schedule 与 scheduled-report 分钟扫描 | **仍存在** | `cmd/scheduler/main.go:63-68` 只注册 11 条静态 job 且不连 PG；`internal/scheduler/jobs.go:28-40`；对照 `backend/app/core/scheduler.py:232-273`（APScheduler 两个动态源） |
| P1 | `jobs` / `job_runs` 完成状态未同事务；internal API key mutation 与 audit 未同事务 | **部分修复** | ✅ `internal/internaljobsrunner/runner.go:659-737` 已改为单事务 + savepoint；❌ `internal/tasks/tasks_run_job.go:181-222,359-379` 仍是两次独立提交；`internal/api/internal_keys/handler.go:105-124` 先提交再审计 |
| P1 | 静态 route manifest 不能证明真实的 registrar/wiring | **成立**（详见 §3.2） | `scripts/route_audit/parse_go_routes.py` 纯正则扫源码，不构造 router、不看 `GO_API_OWNED` |
| P2 | 参数校验时序与少量契约差异 | **部分成立，但 PR 举的例子不准确** | 实测 `GET /api/v1/ai-insights/abc` 返回 **422**（`internal/api/ai_insight/handler.go:659-666`）而非 PR 所说的 404；真实差异是 `id<=0` 给 422 而 FastAPI 给 404、`GET /api/v1/jobs/abc` 给 400 而全站是 422、panic 兜底返回 `text/plain` |

---

## 3. PR 未列出、本次审核新发现的问题

### 3.1 架构 / 切流（最高优先级）

**A-1｜Mount 冲突是「任意两两」，不是「三件套」**
实测四种组合 `{agent+commerce}`、`{agent+credentials}`、`{commerce+credentials}`、三者全开全部 panic。且 `cmd/gateway/dependencies_test.go:84,92` 恰好同时启用了 `agent_credentials` + `agent_commerce`，但只断言 `len(CustomRegistrars) >= 25`、从不调用 `NewRouter`，缺陷在测试里擦肩而过；`internal/httpserver/owned_routes_test.go` 只覆盖 health/exchange_rates/notifications/alerts/profile 五个模块。
→ 修复时必须补「全模块开 → 真实构造 router」的门禁测试。

**A-2｜回退粒度只到「前缀」，不是「路由」**
实测（chi v5.5.0，复现程序见 §6）：同一 router 下

| 请求 | 结果 |
| --- | --- |
| `/api/v1/agent/known` | 200，Go handler |
| `/api/v1/agent/unregistered` | **404，不回落 FastAPI** |
| `/api/v1/projects/manage`（前缀未挂载） | 200，正常代理到 FastAPI |

即一旦通过 `GO_API_OWNED` 开启某模块，该前缀下任何 Go 未实现/方法不匹配的路径在生产上就是硬 404/405，**不存在「单模块内按路由灰度」**。同时根级路径上「方法未注册」反而会被 `/*` 兜底代理给 FastAPI，两种形态行为不一致。
→ 结论：切流必须按前缀原子推进，且每个前缀必须 100% 覆盖后才可开。

**A-3｜asynq 与 Celery 协议不互通**
Go 侧使用 asynq 自有 Redis key（`internal/queue/client.go:44-52`），与 Python Celery/kombu 队列不兼容。一旦 Go 进程 enqueue，消息进入**没有消费者的 asynq 队列**。
→ 结论：任务体系不能「两个 worker 共存消费同一队列」平滑过渡，必须原子切换或双写。

### 3.2 路由覆盖声明的证明力边界

`623/623` 是**源码级字面量对账**，不是运行期证明。六条硬证据：

1. **脚本从不构造 router**：`parse_go_routes.py:7` 只扫 `internal/api/**/*.go` 与 `httpserver/routes.go`，不读 `cmd/gateway/dependencies.go`、不执行 `chi.Routes()`。
2. **`active` 是恒真式**：`parse_go_routes.py:10-24` 的 `ACTIVE_DIRS` 与 `internal/api` 下 66 个模块目录完全相同（差集为空），判定只有 `mod in ACTIVE_DIRS`；`UNWIRED_HINTS` 是永不触发的死代码，因此 `source_only_unwired = 0` 是构造出来的。
3. **完全不看 `GO_API_OWNED`**：`internal/httpserver/routes.go:119-123` 只有模块被启用才 `RegisterRoutes`；按生产配置实际只挂 17 条路由。
4. **manifest 快照不是 main**：`stage7-route-manifest.json` 记录 `head=0f55f1f3`、`branch=plan/go-backend-refactor`、`worktree_dirty=true`、`repository_root=/Users/damon/.paseo/…`，即别人 macOS 上的脏 worktree。
5. **`verify_route_manifest.py` 是自证**：只读自己生成的 manifest 并断言硬编码的 623/128/0，证明的是清单内部自洽。
6. **解析器 OS 依赖**：`parse_go_routes.py` 依赖 `str(path)` 前缀判断与 `line>150` 硬编码（`:353,406-409`）。Windows 上 29 条 `agent:ad_analysis` 路由被丢弃 → 594/623，`verify` 直接 exit 1。把 5 个脚本的路径统一为 POSIX 后同 commit 复跑得 655/655、623/623、0 missing，与已提交 manifest 一致 —— 说明**路由本身没缺，是解析器不可移植**。另外 10 条 `internal_ad_data` operation 的 source 由 `build_route_manifest.py:54-57` 硬编码补齐。

### 3.3 安全 / 稳定性

| 级别 | 问题 | 证据 |
| --- | --- | --- |
| P1 | 两处上传用 `io.ReadAll` 且**无体积上限**，网关是全部流量入口，可被单请求 OOM | `internal/api/sku_info/handler.go:438-449`、`internal/api/shipment_schedules/handler.go:609-621`（同仓 `ad_upload/handler.go:61-64` 已有 50MB 校验，属漏写） |
| P1 | **审计与业务写非原子**：业务已提交 → 审计失败 → 返回 500 → 客户端重试 → 重复创建/二次删除 404（约 25 处） | `internal/api/projects/handler.go:128-136`、`shipment_schedules/handler.go:577-604`、`sku_info/handler.go:408-432` 等 |
| P1 | `GO_API_TRUSTED_PROXY_SECRET` 为空时不做启动校验 → 全站 master-key 请求 403 且日志无提示 | `internal/config/config.go:131,168-179`；`internal/auth/api_key.go:54-58,142-149` |
| P1 | internal API key 创建缺单例预检 → 第二次创建返回 500 而非 409 | `internal/store/api_keys.go:70-118` vs `backend/app/api/v1/endpoints/internal/api_keys.py:99,112-115` |
| P1 | run-now 对 `is_active=false` 的 schedule 仍建 pending 行并入队 → 永久 pending + asynq 重试 | `internal/store/ai_insight_schedule.go:400-461`、`internal/api/ai_insight/generator.go:123-125` |
| P2 | service unavailable 被映射成 501（客户端会当永久不支持而放弃重试），同仓其它包用 503 | `internal/api/agent/types.go:51` |
| P2 | panic 兜底返回 `text/plain` 小写文案，破坏 `{"detail": …}` 契约 | `internal/httpserver/middleware.go:85` vs `internal/httpapi/json.go:26-30` |
| P2 | 9 个 registrar 的 `requireAPIKey == nil` 时 fail-open（当前接线恒非 nil，属默认值隐患） | `internal/api/auth/registrar.go:26` 等 9 处 |
| P2 | 未知模块名静默忽略，切流「看起来成功实际没接管」 | `internal/config/config.go:423-431`；启动日志只打 addr 与 fastapi_origin |

### 3.4 门禁 / 测试盲区

1. **`go test ./...` 不绿**：Windows 上 4 包 12 例失败（7 例 symlink 权限、2 例硬编码 `/` 断言、1 例 multipart 平台差异、2 例真实 Windows 路径缺陷）。
   - 真实代码缺陷：`internal/api/product_analysis_reports/handler.go:196`（`url.Parse` 把盘符 `C:` 当 scheme → 绝对路径恒 404）、`:205`（`filepath.IsAbs("/abs")` 在 Windows 为 false）。Linux 生产不受影响，但本地门禁永远红。
2. **`internal/store` 真库集成套件默认不跑**：`GO_API_TEST_DATABASE_URL` 未设置时 `internal/store/integration_test.go:19-32` 等 4 处 `t.Skip`；全仓 40 处 skip、462 处 fake/mock。
   - **但 CI 并非完全没有真库覆盖**（此前判断需修正）：`.github/workflows/test-ci.yml` 的 `live contract (FastAPI ↔ Go)` job 会起 PostgreSQL service、灌固定数据，再对 14 条 GET 逐字段比对 FastAPI 与 Go 的响应。也就是说核心读接口在 CI 上有真实 SQL 执行证据。
   - 仍缺的是**广度**：`internal/store` 下数百个 store 方法的 SQL 只有 fake 覆盖，`live contract` 只挑 14 条。要把「SQL 字符串正确」升级为「SQL 执行正确」，仍需给 `backend-go` job 配上 `GO_API_TEST_DATABASE_URL`（指向 CI 的 Postgres service）。
3. **4 个 agent 包零测试，共 11,687 行**：`agent_commerce`(4,220) / `agent_inspection`(3,151) / `agent_monthly_reports`(2,481) / `agent_credentials`(1,835) —— 恰是有写权限、上传、密钥管理的部分，风险与覆盖倒挂。

---

## 4. 代码质量的正向结论（避免误判）

评审前预期会抓到大量空壳，实际未发现：

1. **不是空壳**：抽查 `agent`/`crm`/`ai_insight`/`monthly_reports`/`digital_employees`/`page_render`/`report_reconciliation`/`category_research`/`inspections`/`amazon_review_tracking`/`product_analysis`/`scheduled_reports`，全部真实调用 store 且 store 内有真实 SQL；抽查 52 张表名 52/52 存在于 Alembic 迁移；nil store 一律 fail-closed（503/401）而非返回零值。
2. **安全水位高于被替换的 FastAPI**：`internal/auth/api_key.go:142-149` 常数时间比较（Python 侧是明文 `==`）；master key + 代理密钥双因素且转发前 `Header.Del`（`:105`）；`internal/agentauth/auth.go:162-241` 四要素校验 fail-closed；`scope.go:92-107` 通配 `*` 显式拒绝 `agent_provisioning`；写接口用 URL 覆盖 body 防越权。
3. **无 SQL 注入面**：621 处 `fmt.Sprintf` 全部落在表名/列名白名单 switch 与 `$n` 占位符上（`internal/store/internal_ad_data.go:270-295`、`ad_upload_ingest.go:1022-1027`、`complaints.go:699-757`）。
4. **契约还原到字段级**：抽查 6 组端点，字段名、分页四件套、201/204、`{"detail":…}`、422 的 Pydantic 数组结构全部对齐；`internal/httpapi/timestamp.go:11-22` 显式实现微秒精度且零偏移渲染为 `Z`。
5. **事务纪律好**：`RunInTx` 100+ 处，人工复核 36 个可疑点无真正「多写无事务」。
6. **桩为零**：生产代码 `TODO|FIXME|not implemented|未实现` 0 命中；`panic(` 仅 8 处且均为启动期/不可能分支。

---

## 5. 距离「用 Go 完整替换 FastAPI」的差距

### Tier A：可切流（FastAPI 继续兜底，按模块灰度）

1. 修 P0 Mount 冲突，并补「全模块开 → 构建 router」门禁；
2. 修 P1 上传上限、审计非原子、internal key 事务；
3. 把 `GO_API_OWNED` 变成真正可配置的灰度开关（当前 `deploy-remote.sh` 硬编码 5 个模块，仅 `deploy-local.sh` 有变量）；
4. 审计脚本可移植化（UTF-8 读文件、`as_posix()`、输出目录参数化、verify 独立复算）；
5. 用 `GO_API_TEST_DATABASE_URL` 指向 `BLF_test` 跑一次 `internal/store` + `internal/tasks`，把 SQL 从「字符串正确」升级为「执行正确」。

### Tier B：可下线 FastAPI（当前全缺）

| 缺口 | 现状 | 证据 |
| --- | --- | --- |
| 部署 `go-worker` + `go-scheduler` | compose 只有 `go-api`；Python 侧仍有 `api`/`celery`/`celery-scheduled`/`beat` 四容器 | `deploy/docker-compose.yml:8-164` |
| `dispatch_one` / `generate_delivery_summary` | `Executor=nil`，调用即失败 | `internal/tasks/handler.go:22-26,255-257` |
| 两个动态调度源 | 0/2 | `backend/app/core/scheduler.py:255-273` |
| PDF 生成（FNSKU 标签 / 类目 summary_pdf / 月报 PDF） | Go 只有 PDF **读**库 | `internal/tasks/monthly_report_xlsx.go:92`、`internal/api/monthly_reports/handler.go:712-723`（仅 302） |
| Playwright 截图 + PIL 合成 | Go 无浏览器/图层能力 | `backend/app/services/scheduled_report/screenshot.py:104-171` |
| Alembic 移交 | 261 迁移 / 21,827 行仍由 Python 镜像执行；`backend-go` 全仓 grep `alembic` 0 命中 | `deploy/docker-compose.yml:8-15` |
| OpenAPI 契约再生成 | `backend/scripts/openapi_export.py` 为 Python | — |
| 剩余业务计算核对 | `backend/app/services` 341 文件 / 97,070 行 | — |

### 覆盖度对照

| 维度 | Python | Go | 覆盖率 |
| --- | --- | --- | --- |
| Celery task 名称 | 18（+`office_tick` 已移出 Beat） | 18 个 type | 17/18 = 94% |
| 真实 task 处理器 | 18 | 16 真实现 + 2 空壳 | 16/18 = 89% |
| Beat 静态 cron | 11 | 11（逐条一致） | 11/11 = 100% |
| 动态调度源 | 2 | 0 | 0/2 |
| 异步进程部署 | 3 容器 | 0 | 0 |
| HTTP operation 线上实际接管 | 623（FastAPI 全量） | ≈17 | ≈2.7% |

---

## 6. 复现命令

```bash
# 门禁（Windows 上当前会 4 包 12 例失败，见 §3.4）
cd backend-go && go build ./... && go vet ./... && go test ./... -count=1

# 真库集成测试（需要本地 BLF_test）
GO_API_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/BLF_test?sslmode=disable' \
  go test ./internal/store/ ./internal/tasks/ -count=1

# 路由对账（先修脚本的可移植性，否则 Windows 上得到 594/623）
PYTHONUTF8=1 python backend-go/scripts/route_audit/parse_fastapi_routes.py
PYTHONUTF8=1 python backend-go/scripts/route_audit/parse_go_routes.py
```

回退粒度实测（chi v5.5.0）：

```go
router := chi.NewRouter()
router.Route("/api/v1/agent", func(r chi.Router) { r.Get("/known", handler) })
router.Handle("/*", fastAPIFallback)
// GET /api/v1/agent/known        -> 200 go-handler
// GET /api/v1/agent/unregistered -> 404（不回落）
// GET /api/v1/projects/manage    -> 200 fastapi-fallback
```

---

## 7. 后续处置

本文件的结论已转化为分支 `fix/go-backend-blockers` 的修复集：

| 结论项 | 处置 | 状态 |
| --- | --- | --- |
| A-1 Mount 冲突（P0） | 三个 Agent registrar 改为 `router.With(...)` + 全路径注册，不再 Mount 同一前缀；新增 `internal/httpserver/agent_registration_test.go` 作为「全部 Agent registrar 同 router」回归门禁 | 已修 |
| 3.3 上传无上限 | `sku_info` / `shipment_schedules` 三处上传加 `http.MaxBytesReader`（20 MiB），超限 413 + `{"detail": …}` | 已修 |
| 3.3 审计非原子 | 新增 `audit.BestEffort` 装饰器并在 gateway 装配：`LogAction` 失败只记日志不再让已提交请求返回 500，`LogActionTx` 仍 fail-closed。**彻底原子化**（业务写与审计同事务）需要 store 层接收 tx，列为 follow-up | 过渡修复 |
| 3.3 internal API key 事务 | 创建流程改为单事务内写审计，`23505` 映射 409 | 已修 |
| 3.4 门禁红灯 | 修 `product_analysis_reports` 两个 Windows 路径缺陷；符号链接用例改为「探测能力后再决定 skip」；两处硬编码分隔符断言改为按 `filepath.Abs` 构造期望值；multipart 路径穿越用例改为直接单测校验函数 | 已修 |
| 3.2 Tier A-3 | `deploy-remote.sh` / `deploy-local.sh` / `deploy-dashboard.yml` 统一支持 `GO_API_OWNED_MODULES`（CI 可用仓库变量覆盖，缺省仍是原 5 模块） | 已修 |
| Tier A-5 真库集成测试 | **本机未能执行**（无 Postgres 实例；临时 `initdb` 集群可用，但 `alembic upgrade head` 无法从空库重建 schema，报 `UndefinedTable: 关系 "projects" 不存在`，因基线 schema 早于 Alembic）。**已由 CI 补上**：PR #810 的 `live contract (FastAPI ↔ Go)` job 在真 PostgreSQL 上跑通 14 条 GET 比对，`backend-go test + vet` job 同时跑 `go test ./...` 与 `go test -race ./...` 全绿 | CI 已覆盖 |
| Tier B 异步体系 | 单独立项，见 `stage8-async-cutover-plan.md` | 立项 |

> 注意：`go test ./...` 在本机全绿后，曾有一次在**两个 `go test ./...` 并发执行**时出现 `TestStage7BAIChatContract` 偶发失败（单独与整包复跑均通过）。如果是并行跑测试导致的竞态，后续需要在 CI 里串行化或定位共享状态。

