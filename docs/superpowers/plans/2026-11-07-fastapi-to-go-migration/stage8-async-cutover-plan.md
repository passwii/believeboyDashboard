# Stage 8：异步体系切换立项（Celery/APScheduler → asynq/gocron）

> 立项日期：2026-11-09
> 前置结论：见 [`review-2026-11-09-go-readiness.md`](./review-2026-11-09-go-readiness.md)
> 状态：**立项，未实施**
> 目标：让 Python 侧 `celery` / `celery-scheduled` / `beat` 三个容器可以下线

---

## 1. 为什么必须单独立项

HTTP 路由可以按前缀灰度、随时回退；异步体系不行，原因有二：

1. **协议不互通**：Go 用 asynq（自有 Redis key，`backend-go/internal/queue/client.go:44-52`），Python 用 Celery/kombu。两个 worker 不能消费同一队列，因此不存在「新旧并行各跑一半任务」的平滑路径。
2. **触发源分散在三处**：Celery Beat 静态 cron（11 条）、FastAPI 进程内 APScheduler 动态源（2 个）、业务代码里的 `.delay()` 直投。切 Go 必须三处同时就位，否则表现为「任务不报错但永远不跑」。

---

## 2. 现状盘点（2026-11-09 实测）

### 2.1 任务（18 个 task name）

| Python task | Go 实现状态 | 说明 |
| --- | --- | --- |
| `app.celery_tasks.run_job.run_job` | ✅ 已实现 | 仅 `monthly_report` / `product_analysis` 两种 job_type，与 `script_registry.py` 等价 |
| `...monthly_report_preview.build_monthly_report_preview` | ✅ | |
| `agent_monthly_report_cleanup` | ✅ | |
| `generate_insight` | ✅ | 但见 §2.4 缺陷 |
| `execute_insight_run` | ✅ | |
| `alert_detect` | ✅ | |
| `return_analysis.refresh_daily` | ✅ | |
| `crm_sea_reclaim` / `crm_task_reminder` / `crm_follow_up_reminder` / `crm_rule_engine` / `crm_stale_email` | ✅ | |
| `agent_api_audit_cleanup` / `operation_audit_cleanup` | ✅ | |
| `ai_chat_token_usage.refresh_daily` | ✅ | |
| **`dispatch_one`** | ❌ **空壳** | 落到 `handler.execute` → `config.Executor`，worker 未注入 → 每次 `ErrExecutorNotConfigured` |
| **`generate_delivery_summary`** | ❌ **空壳** | 同上 |
| `office_tick` | ➖ 无需 | Python 侧已从 Beat 移除（`celery_shared.py:80-85`），任务定义保留 |

### 2.2 调度

| 来源 | Python | Go |
| --- | --- | --- |
| Beat 静态 cron | 11 条（`backend/app/tasks/celery_shared.py:86-144`） | ✅ 11 条完全一致（`backend-go/internal/scheduler/jobs.go:28-40`） |
| 订阅每分钟扫描 | `_run_minutely_scan`（`backend/app/core/scheduler.py:266-273`） | ❌ 无 |
| Insight 动态调度 | `reload_insight_schedules()`（`backend/app/core/scheduler.py:255-261` + `backend/app/services/insight_schedule_service.py`） | ❌ 无 |

### 2.3 进程

`deploy/docker-compose.yml` 只有 `go-api`；Python 侧仍有 `api` / `celery` / `celery-scheduled` / `beat` 四个容器。**没有任何 Go worker/scheduler 部署单元。**

### 2.4 相关缺陷（切换前必须修）

| 级别 | 缺陷 | 位置 |
| --- | --- | --- |
| P1 | AI Insight run-now 重复创建：一次点击建 2 行，返回前端那行永久 `pending`，`run_count` +2 | `internal/api/ai_insight/handler.go:494-500`、`internal/tasks/tasks_external.go:49-80`、`internal/store/ai_insight_schedule.go:400-461` |
| P1 | run-now 不校验 `is_active` → 永久 pending + 重试风暴 | `internal/store/ai_insight_schedule.go:400-461`、`internal/api/ai_insight/generator.go:123-125` |
| P1 | enqueue 位于 DB commit 之前（3 处） | `internal/api/scheduled_reports/handler.go:501-547,597-644,702-741` |
| P1 | `jobs` / `job_runs` 完成状态两次独立提交；失败路径 best-effort 忽略错误 | `internal/tasks/tasks_run_job.go:181-222,359-379,532-545` |
| P2 | `dispatch_one` 幂等键带纳秒时间戳，队列层去重失效 | `internal/api/scheduled_reports/handler.go:619` |

---

## 3. 需要补齐的能力

### 3.1 定时报表全链路（`dispatch_one`）

Python 实现 1,503 行（`backend/app/services/scheduled_report/dispatcher.py`），包含：订阅查询 → 生成并缓存报表 → AI 摘要 → 邮件发送 → ledger 落库 → 重发/幂等。

Go 侧建议拆分：
1. `internal/scheduledreport/` 新建包，承载 dispatcher 主体（先做无 AI、无截图的路径）；
2. `Executor` 接口实现接入 `cmd/worker`（当前 `HandlerConfig.Executor` 无实现是空壳根因）；
3. 幂等：沿用 `scheduled_report_ledger_entries` 的既有唯一键，去掉纳秒时间戳。

### 3.2 AI 摘要（`generate_delivery_summary`）

依赖 `internal/ai`（已有 provider/stream 能力）+ 邮件（`internal/mailer` 已等价）。需要确认 Python 侧 prompt 与模型选择是否需在 Go 侧复刻到字段级。

### 3.3 两个动态调度源

1. **订阅每分钟扫描**：gocron `* * * * *`，按 `Asia/Shanghai` 取 `hour/minute`，查 `scheduled_report_subscriptions`（enabled + dispatch_hour + dispatch_minute），按 `frequency` 分流 daily/weekly/monthly，再按 `dispatch_weekday` / `dispatch_day` 过滤，最后入 asynq `scheduled` 队列（每订阅错峰 countdown）。
2. **Insight 动态调度**：scheduler 启动时连 PG 读 `insight_schedules`（`is_active`），按 `cron_expression` 注册 gocron job，并支持运行时增删改（对应 Python 的 `reload_insight_schedules`）。注意与 `cmd/scheduler/main.go` 当前「不连 PG」的假设冲突，需要引入 `DATABASE_URL`。

3. **分布式锁**：沿用 `scheduler.NewRedisLocker`（已实现 SETNX，`internal/scheduler/lock.go`）。

### 3.4 部署单元

`deploy/docker-compose.yml` 新增：
- `go-worker`：`cmd/worker`，消费 `default,reports,insights,ai_summary,scheduled` 五个 asynq 队列；
- `go-scheduler`：`cmd/scheduler`，单实例（Redis 锁保证不重复）。
- 与 Python 的时间重叠窗口必须有「同一任务只由一个运行时执行」的硬保证，否则会出现双发送（报表邮件最危险）。

### 3.5 Python 独占能力（与异步强耦合）

| 能力 | Python 位置 | Go 现状 | 处置建议 |
| --- | --- | --- | --- |
| Playwright 截图（邮件报表核心） | `backend/app/services/scheduled_report/screenshot.py:104-171` | 无 | 引入 chromedp / rod，或保留 Python sidecar 只做截图 |
| PDF 生成/叠加 | `product_label_overlay.py:485-520`、`category/export.py:341-356`、月报 PDF | 只有 PDF 读库 | 引入 Go PDF 写库（如 gofpdf / maroto），或 sidecar |
| Pillow 图层合成 | 同上 | stdlib `image` 仅缩略图 | 视需求决定 |

---

## 4. 切换顺序（建议）

1. **修 §2.4 的 P1/P2 缺陷**（可独立于异步切换先做）；
2. **实现两个动态调度源**，但先以「只记录不派发」的 dry-run 模式跑一周，对比 Python 触发次数；
3. **实现 `dispatch_one` 无 AI/无截图路径** + 幂等键修正；
4. **部署 `go-worker` / `go-scheduler`**，但队列与 Python 隔离（不同 Redis key），先由人工触发验证；
5. **逐个 task 切换**：把 Python Beat 对应条目删除 → 由 Go scheduler 接管同一 task name；每切一个观察 24h；
6. **最后切 `dispatch_one`**（涉及对外邮件，风险最高），切换前准备「双发检测」告警；
7. **AI 摘要 / 截图 / PDF** 视 sidecar 决策收尾；
8. 收尾：下线 `celery` / `celery-scheduled` / `beat` 三个容器。

---

## 5. 验收标准

- [ ] `GO_API_OWNED` 全量开启且 Go gateway 稳定运行 ≥ 7 天，fallback 日志中无业务调用；
- [ ] `dispatch_one` 与 `generate_delivery_summary` 有真实实现且无 `ErrExecutorNotConfigured`；
- [ ] 两个动态调度源在 dry-run 对比中与 Python 触发次数一致（允许 ±1 次边界误差）；
- [ ] `scheduled_report_delivery_logs` 无重复发送记录；
- [ ] `jobs` / `job_runs` 状态无「jobs=success 且 job_runs.finished_at IS NULL」残留；
- [ ] 三个 Python 异步容器删除后，`celerybeat-schedule` 与 asynq 队列均无积压增长。

---

## 6. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 双运行时重复执行同一任务 | 用户收到重复邮件/重复 AI 计费 | 切换期任务名互斥 + 双发检测告警 |
| asynq 与 Celery 队列键冲突 | 消息进入无人消费队列 | 显式隔离 Redis key 前缀，切换时一次性迁移 |
| Go scheduler 引入 DB 依赖 | 启动失败面扩大 | 启动校验 + 失败可见日志（当前 `cmd/scheduler` 只依赖 Redis） |
| 动态调度时区偏差 | 报表在错误时间发送 | 强制 `Asia/Shanghai` 并用 CST 用例覆盖（`internal/scheduler/scheduler.go` 已有 tz 校验） |
