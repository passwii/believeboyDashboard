# Phase 3 — 后台任务与调度（Celery → Asynq + gocron）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 1 全绿（领域包）；可与 Phase 2 并行

**Goal:** 21 个 Celery task + Celery Beat 定时表 + APScheduler（`app/core/scheduler.py`）全部搬到 Go，报告管线（构建→AI 增强→截图→邮件）端到端跑通。

**Architecture:** `services/worker` 单二进制内跑 Asynq worker + gocron scheduler（替代原来 3 个 systemd 单元：celery / celery-scheduled / beat，见 Phase 6）。队列映射：`default/reports/insights/scheduled/ai_summary` → Asynq 同名队列（权重与 Celery 一致）。幂等：沿用 `ledger_service.py` 的 dispatch ledger 语义（key 生成规则原样搬）。

**新增依赖：** `hibiken/asynq`（+ `asynqmon` 监控）、`go-co-op/gocron/v2`、`go-rod/rod`、`xuri/excelize`（写 Excel，替代 openpyxl `dataframe_to_rows` 逐格写）。

## 任务清单对照（Python 源 → Go 目标，共 21 task）

| # | Python 源 | 周期（celery_app.py beat_schedule） | Go handler | 备注 |
|---|-----------|-------------------------------------|-----------|------|
| 1 | `celery_tasks/office_tick.py` | 每 3s | `worker/tasks/office_tick.go` | 数字员工状态推进，高频，性能单测 |
| 2 | `celery_tasks/crm_sea_reclaim.py` | 每日 03:00 | `worker/tasks/crm.go`（合并 3–6） | 公海回收 |
| 3 | `celery_tasks/crm_task_reminder.py` | 每小时 :05 | 同上 | 24h 到期扫描 |
| 4 | `celery_tasks/crm_follow_up_reminder.py` | 每日 09:00 | 同上 | 7 天未跟进 |
| 5 | `celery_tasks/crm_rule_engine.py` | 每日 09:05 | 同上 | 规则执行 |
| 6 | `celery_tasks/crm_stale_email.py` | 每日 09:10 | 同上 | Resend 发信 |
| 7 | `celery_tasks/alert_detection.py` | 每 15min | `worker/tasks/alert.go` | 调 Phase 1 `pkg/alert` |
| 8 | `celery_tasks/return_analysis_refresh.py` | 每日 03:00 | `worker/tasks/return_analysis.go` | 物化表刷新 |
| 9 | `celery_tasks/return_analysis_rebuild.py` | 手动 | 同上 | 全量重建 |
| 10 | `celery_tasks/agent_api_audit_cleanup.py` | 每日 04:00 | `worker/tasks/cleanup.go`（合并 10–11） | 90 天 purge |
| 11 | `celery_tasks/operation_audit_cleanup.py` | 每日 04:30 | 同上 | 90 天 purge |
| 12 | `celery_tasks/ai_chat_token_usage_refresh.py` | 每日 03:15 | `worker/tasks/ai.go`（合并 12–13） | 快照聚合 |
| 13 | `celery_tasks/ai_summary.py` + `insights/` | 按需/定时 | 同上 | AI 摘要 |
| 14 | `celery_tasks/run_job.py` | 按需（reports 队列） | `worker/tasks/jobs.go` | 调 `product_analysis` 等价逻辑 |
| 15 | `celery_tasks/scheduled_report.py`（dispatch_one） | 按需（scheduled 队列） | `worker/tasks/dispatch.go` | 见 Task 3.3 |
| 16 | `celery_tasks/ping.py` | — | 健康检查 handler | 存活探针 |
| 17 | `core/scheduler.py` minutely scan | 每分钟（北京时） | `worker/scheduler/scan.go` | hour+minute+weekday+day 匹配语义原样搬 |
| 18 | insight schedules（DB 动态） | 动态 | `worker/scheduler/insight.go` | DB 加载 + 动态注册/注销 |
| 19 | `tasks/scripts/product_analysis.py`（624 行，最重计算） | 经 run_job 触发 | `worker/jobs/product_analysis.go` | 调 Phase 1 `pkg/ingest` + `pkg/aggregate`，DataFrame 常驻内存问题在此终结 |
| 20 | `tasks/scripts/monthly_report.py` | 经 run_job 触发 | `worker/jobs/monthly_report.go` | — |
| 21 | R2 删除重试（`r2_delete_failures`） | 定时 | `worker/tasks/r2_retry.go` | Phase 2-Task 2.14 的 dead-letter 消费者 |

## 任务

### Task 3.1：worker 骨架 + Asynq + gocron 接线

- [ ] Step 1: `services/worker/main.go`：Asynq server（5 队列权重配置与 `celery_app.py:75-87` 路由一致）+ gocron scheduler 同进程（`ADVISORY LOCK` 单实例保护，对齐 `scheduler.py:17` `_try_acquire_lock`）。
- [ ] Step 2: beat_schedule 全表搬运（上面 1–12 的周期一字不差，时区 `Asia/Shanghai`）+ `asynqmon` 本地可访问验证。
- [ ] Step 3: 重试/超时策略：Celery 的 `max_retries`/`time_limit` 逐个对到 Asynq `Retry`/`Timeout` 选项（对照表写 `worker/README.md`）。
- [ ] Step 4: Commit：`feat(go): worker 骨架与调度表`。

### Task 3.2：报表构建三件套（daily/weekly/monthly）

**源：** `services/scheduled_report/report_builder_{daily,weekly,monthly}.py` + `context_helpers.py` + `data_gate.py`

- [ ] Step 1: `group_by().all()` + Python 侧累加一律改 SQL 聚合（`report_builder_monthly.py:97,606,638,692,977` 是重点）。
- [ ] Step 2: 三个 builder 输出 struct 对齐，契约测试用 Python 版对同项目同周期跑 diff（金额零差异）。
- [ ] Step 3: Commit：`feat(go): 报表构建器三件套`。

### Task 3.3：AI 增强 + 邮件发送

**源：** `ai_enhancer_{daily,weekly,monthly}.py` + `email_sender*.py`（4 文件）+ `ai_timeout.py`（`SIGALRM` 超时保护 → Go `context.WithTimeout`）

- [ ] Step 1: LLM 摘要调用走 Phase 2 的 AI 客户端；超时语义对齐（超时后降级为无 AI 版报表，**不 fail 整个 dispatch**——对齐现有行为）。
- [ ] Step 2: Resend 发信（模板变量逐个对齐；附件 base64 截图沿用 Phase 3.4 输出）。
- [ ] Step 3: `ledger_service.py` 幂等 key 原样搬；重复 dispatch 单测（调两次只发一封）。Commit：`feat(go): AI 增强与邮件发送`。

### Task 3.4：截图（Rod 替代 Playwright）

**源：** `services/scheduled_report/screenshot.py`（291 行；注释记载 2026-07-28 事故：Chrome 148 在 2 核 VPS 打满 CPU → worker SIGTERM → Redis 级联崩溃；当前 pin playwright 1.52.0/Chromium-1169 + 2x 缩放）

- [ ] Step 1: Rod 复刻 `html_to_png`（headless 参数对齐那 8 个 restrictive args）+ 圆角后处理（PIL → Go `image` 标准库）+ 缩略图 + R2 上传（复用 Phase 2 uploads 链路）。
- [ ] Step 2: 像素 diff：对 10 份历史报表 HTML，Rod vs Playwright 输出 SSIM/像素差异 < 1%；不达标项列清单。
- [ ] Step 3: 资源上限：单截图内存/CPU 上限（吸取 07-28 事故教训；gocron 并发截图数限 2）。
- [ ] Step 4: 若有超标项 → 启动 Python sidecar fallback（50 行 FastAPI，只装 playwright，走 HTTP），主链路不阻塞。Commit：`feat(go): Rod 截图管线（附像素 diff 报告）`。

### Task 3.5：dispatcher 编排 + 端到端验证

**源：** `services/scheduled_report/dispatcher.py`（Celery/threadpool 双模 → Go 只保留 Asynq 模；`time.sleep` 舞台节流删掉）+ `subscription_service.py`（删除订阅时清 R2）

- [ ] Step 1: 端到端测试：订阅 1 个测试项目 → 触发 dispatch → 断言 R2 有文件 + ledger 有记录 +（staging）收到邮件。
- [ ] Step 2: 其余 Task（3.1 表中 1–16、19–21）逐个搬运 + 单测。Commit：`feat(go): worker 全量任务`。

## Exit Criteria

- [ ] 21 task 全部有 Go handler + 至少 1 个单测
- [ ] 报表端到端（构建→AI→截图→邮件→ledger）在 staging 跑通 3 个真实项目
- [ ] 像素 diff < 1% 或 sidecar fallback 就绪
- [ ] `office_tick` 3s 周期下 worker 内存稳定（观察 1h，无增长趋势）
