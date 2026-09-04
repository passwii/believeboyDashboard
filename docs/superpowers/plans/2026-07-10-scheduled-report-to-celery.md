# 方案：将定时报告（scheduled_report）迁移进 Celery Worker

- **日期**：2026-07-10
- **状态**：设计评审通过（frozen，可作为实现阶段输入）
- **评审回合**：P0×2 / P1×3 / P2×4 共 9 条决策已闭环
- **核心红线**：🔴 **绝不重复发邮件**（P0-2 护栏兜底；其他优化都可让 LLM 浪费、缓存退化，邮件路径不被重复触发即可）

---

## 1. 背景与动机

### 1.1 现状

后台任务有**两套完全脱钩的系统**：

| 系统 | 运行位置 | 职责 | 触发方式 |
| --- | --- | --- | --- |
| **Celery Worker**（`belieboy-worker.service`） | 独立 systemd 进程 | 手动报表 `run_job`、AI 洞察 `generate_insight` | 业务代码 `.delay()` |
| **APScheduler** | **API 进程内**（`app/main.py:108` startup 调 `init_scheduler()`） | 定时报告（数据→HTML→截图→邮件） | 每分钟 cron 扫描订阅 → `ThreadPoolExecutor`（≤8 线程）同步跑 |

代码证据：

- `scheduler.py:155` 在 API 进程内 `BackgroundScheduler().start()`，每分钟 `_run_minutely_scan` 匹配订阅；
- `dispatcher._dispatch_one`（`dispatcher.py:588`）在 API 进程内 `ThreadPoolExecutor` 里**同步**跑完"拉数据→渲染→截图→发邮件"全流程；
- `enqueue_ai_summary_generation`（`ledger_service.py:406`）**也不是 Celery**，只是 `threading.Thread(daemon=True).start()`；
- `grep` 确认 `app/services/scheduled_report/` 目录内零 `enqueue_job` / `run_job` / `job_type` / `.delay(` 引用。
- **补发链路（`resend_ledger_entry_async`）走的是 `dispatcher.py:_dispatch_one_async`（973 行起）**：resend 接口（前端台账补发按钮触发）收到后用 `threading.Thread` 把任务甩到后台线程，跑完"数据→渲染→截图→发邮件"全流程，调 `enqueue_ai_summary_generation` 启 AI 摘要后台线程。它已经在内存形态上"后台化"，但同样不在 Celery 进程内、与本方案同根问题。本方案把 `_dispatch_one_async` 与 `_dispatch_one` 视为同一类主体，**§7 改动清单 + Phase 1 实现路径都要覆盖**：resend 入口必须迁到 Celery（函数体可保留作回滚形态或兜底）。

### 1.2 VPS 生产数据（2026-07-09 拉取）

- **定时报告**（`scheduled_report_*` 表）：启用订阅 **25 个**（daily 11 / weekly 10 / monthly 4）；发送记录 **650 条**，**最近 30 天 437 条**。
- **Celery Worker**（jobs + ai_insights 表）：最近 30 天仅 **22 条**。
- **结论**：定时报告使用量 ≈ Celery Worker 的 **20 倍**，是事实上的"最高频后台功能"——但它跑在 API 进程，不在 Worker。

### 1.3 为什么该迁

1. **重活在 API 进程内跑**：报告生成含 DB 大查询、HTML 渲染、**Playwright headless 截图**、SMTP 发送，与 API 请求共享内存 / DB 连接池。
2. **无 broker 持久化 / 重试**：API 重启即丢失在途报告；Celery 有 `acks_late=True` + `max_retries=3` 天然容错。
3. **未来多副本重复触发风险**：`deployment-runbook.md` 已规划 API `--workers 4`，多副本各自跑 APScheduler 会重复触发。
4. **职责混乱**：最高频的定时报告在 API，Worker 反而跑次常用的手动报表——与 Worker 的设计初衷相反。

---

## 2. 目标

- APScheduler 退化为**纯轻量定时器**：到点只负责把消息 `delay()` 进 broker，立即返回，不执行报告主体。
- 报告生成主体（数据→HTML→截图→邮件）迁为 Celery task，由 Worker 的 **`scheduled` 队列**执行。
- AI 摘要作为独立 Celery 子 task 进 **`ai_summary` 队列**（与主报告解耦，与定时洞察隔离限流）。
- 不破坏 `scheduled_report_delivery_logs` 状态机与前端轮询。

## 3. 非目标

- 不改变订阅模型 / 发送频率 / 邮件模板 / AI 摘要文案逻辑（纯执行位置迁移）。
- 不重构 `run_job` / `generate_insight`（已正确在 Worker）。
- 不处理 `jobs` 表里 `daily_report` 的 4 条历史记录来源（独立遗留）。
- 本次不做 Worker 多进程横向扩展（`celery multi`）。
- 不在 `dispatcher.py:_dispatch_one_async` 函数体内做局部重写（保留供回滚形态或兜底）；但 **resend 入口（`resend_ledger_entry_async`）必须迁到 Celery**（见 §7），与 `_dispatch_one` 同根主体一并覆盖。

---

## 4. 关键设计决策（评审定稿）

> 以下 9 条均已和用户逐条对齐，无歧义。详见 §6 各 Phase 的落地映射。

### 4.1 P0-1 报告日期固化（防跨天错乱）

- APScheduler 在 15:00 触发的那一刻算 `report_date = date.today().isoformat()`，作为 `dispatch_one_task.apply_async(report_date=report_date, ...)` 参数传进去。
- **task 内禁用 `date.today()`**，所有日期推导仅用传入 `report_date`。
- `_summary_cache` / `_dispatch_date_str` 的缓存失效判断也基于**传入 `report_date`**，不再调用 `date.today()`。
- **模块全局同步策略（实现硬约束）**：`dispatcher.py:613-618` 的 `_dispatch_date_str` / `_summary_cache` / `_cache_lock` 仍是模块全局。Celery prefork 后：
  1. 同 worker 子进程内：仍共享（OK）；
  2. 跨 worker 子进程：不共享（P1-3 已接受最坏退化到 ~ 子进程数次）；
  3. **task 入口必须用 `report_date` 强制对齐 `_dispatch_date_str`**：进入 `dispatch_one_task` 后第一段即 `with _cache_lock: if _dispatch_date_str != report_date: _summary_cache.clear(); _dispatch_date_str = report_date`。**禁用 `_dispatch_one` 函数体内部 `date.today()` 算 `today_str` 那一段**（该段与 task 入口的 report_date 已经不一致时仍走 today，会重现台账 7.4/7.5 截图错乱）。
- 模块全局策略写在 Phase 1「抽 `_dispatch_one` 主体到 `dispatch_one_task`」步骤里：用 `_dispatch_one_core(subscription_id, ..., report_date, ...)` 暴露可独立调用函数，`dispatch_one_task` 与旧 `_dispatch_one` 共享该 core；core 首段按上面 1、3 处理模块全局。

### 4.2 P0-2 邮件幂等护栏（防重试重复发邮件）⭐ 承重墙

- task 进入时先查 `scheduled_report_delivery_logs`：是否已存在 `(subscription_id, frequency, report_date)` 的 log 且 `sent_at` 非空（邮件已发）→ **直接 `return`**，不重跑、不重发。
- `send_*_report_email` 成功后**立刻** `mark_delivery_success`（持久化 `sent_at`）并 `db.commit()`，再继续截图 / AI 摘要。
- 复用现有 delivery_log 而非每次新建：先按 `(sub, freq, report_date, triggered_by="auto")` 查，无则创建，有则复用该 log 继续 stage 推进。
- 任何 LLM 浪费 / 重跑可接受，**邮件不能重复**。

- **race window 与唯一键（决策升级，本节同时承载 P0-3 决定）**：当前 `_dispatch_one` 在 `send_*_report_email` 之**前**先 `INSERT delivery_log`（`create_delivery_log_with_stage`，status=preparing），`send_*_report_email` 成功后 `mark_delivery_success` 落 `sent_at` + commit。该窗口下若 Worker 被 kill 而 `sent_at` 未落库，broker 重投 → 第二个 task 看到 `sent_at` 仍为 NULL → **会重发**。这不是理论：SMTP 已吐但本进程被 OOM / kill -9 / broker 抢占都可能发生。
- **P0-3 护栏升级**：在 `ScheduledReportDeliveryLog` 上为 `(subscription_id, frequency, report_date, triggered_by)` 加唯一约束（`UniqueConstraint`）；task 入口 `INSERT ... ON CONFLICT DO NOTHING` 拿到该行 → `SELECT ... FOR UPDATE` 持行锁 → 持锁后查 `sent_at`：非空说明已发，`return`；为空则进入发送路径，并在发送开始时把 stage 推到 `sending_email`、commit，再做 SMTP。整个窗口期**唯一约束挡住并发 task**、**行锁挡住 broker 重投**。
- `scheduled_report_delivery_logs` 表的 alembic 迁移随本方案一起出，回滚迁移即可恢复。
- **回滚影响**：唯一约束 + 新代码一并回滚（Phase 6 改 env 即可）；旧路径不感知这层护栏（用普通 `INSERT`）。

### 4.3 P1-3 缓存复用丧失 → 接受（DB 观察）

- 不引入 Redis 缓存层、不拆独立进程来恢复缓存共享。
- 接受"prefork 子进程内跨任务仍复用，跨子进程退化"——最坏退化到 ~子进程数（2）次。
- 上线后用 `pg_stat_statements` / 慢查询日志观察报表类查询，**确认实际退化幅度再决定要不要进一步优化**。

### 4.4 P1-4 独立 `scheduled` worker 进程（内存隔离 + 顺带减缓存退化）

- 新增轻量 systemd unit：`believeboy-worker-scheduled.service`，ExecStart 为：

  ```
  celery -A app.tasks.celery_app worker -Q scheduled -c 2 --loglevel=info
  ```

- scheduled 进程**不消费** `ai_summary` / `insights` / `reports` / `default`。
- 现有 `reports/insights` worker 进程 `-Q` 改成 `default,reports,insights,ai_summary`（当前是 `default,reports,insights`，本方案在 Phase 4 改造）。
- 收益：
  1. 截图 OOM 不影响手动月报 worker（**核心价值**）；
  2. `scheduled` 单进程 = 缓存共享恢复（P1-3 顺带解决，不过仍要观察 DB）；
  3. 并发 `-c 2` 削峰。

### 4.5 P1-5 触发侧 `countdown` 错峰（不挤同一瞬间）

- `_dispatch_subscriptions` 对同一分钟匹配到的 N 个订阅，按 `sub.id` 排序，第 `i` 个用：

  ```python
  dispatch_one_task.apply_async(
      kwargs={...},
      countdown=i * SCHEDULED_DISPATCH_SPREAD_SECONDS,  # 默认 60s；i 从 0 起（即 0 / 60 / 120 … 秒）
  )
  ```

- 默认间隔 60s，间隔常量配置化（`SCHEDULED_DISPATCH_SPREAD_SECONDS`）。
- 11 个 daily 订阅 15:00 齐发 → broker 错峰 15:00 / 15:01 / ... / 15:10。
- 与 P1-4 独立 `-c 2` 进程**两层防护**：触发侧错峰 + 执行侧限并发。

### 4.6 P2-5 AI 摘要独立 `ai_summary` 队列（B2）

- 新增 `backend/app/celery_tasks/ai_summary.py`：

  ```python
  @shared_task(
      name="generate_delivery_summary",
      bind=True, acks_late=True, max_retries=2,
      soft_time_limit=300, time_limit=420,
  )
  def generate_delivery_summary(self, log_id, ledger_key=None, override_ai_model=None):
      with acquire_remote_semaphore(
          "ai_summary",
          timeout=300,
          max_concurrent=settings.max_concurrent_ai_summary,  # 显式传独立上限（见下方"决策实现注意"）
      ) as acquired:
          if not acquired:
              _mark_ai_summary_failed(log_id, "ai_summary semaphore timeout")
              return {"status": "semaphore_timeout"}
          generate_ai_summary_for_delivery_log(
              log_id=log_id, ledger_key=ledger_key, override_ai_model=override_ai_model,
          )
  ```

- 路由：`task_routes` 加 `"generate_delivery_summary": {"queue": "ai_summary"}`（Phase 1 与 `dispatch_one` 路由块一起写）。
- 独立信号量 key `"ai_summary"`，**上限 `MAX_CONCURRENT_AI_SUMMARY=5`**。
  - 取 5 的依据：现有 `generate_insight` 占 3 路（`max_concurrent_insights=3`），ai_summary 额外允许 5 路 LLM 调用；
  - 留 headroom 给非高峰日触发，避免和 insights 同时跑满撞 LLM provider RPM 阈值；
  - 上限 `le=20`，预留未来增配空间。
- **决策实现注意（M2-升级）**：`acquire_remote_semaphore(name, timeout)` 在 `settings.max_concurrent` 未显式传入时一律落到 `settings.max_concurrent_insights`（现状 3，与 insights 共享）。要让 ai_summary 真独立，task 必须显式传 `max_concurrent=settings.max_concurrent_ai_summary`，且 `acquire_remote_semaphore` 内部应新增按 name 分桶的 settings 取值路径（或者强制不传 `max_concurrent` 时报错）——见本节代码片段的 `max_concurrent=` 必传与 Phase 5 配置项。
- **不加** `ai_summary_status==done` 跳过 LLM 重试——LLM 重试浪费用户接受（红线仅禁重复发邮件）。
- `dispatch_one_task` 末尾改为：`ai_summary_task.delay(log_id=log_id, ledger_key=ledger_key, override_ai_model=ai_model)`。

### 4.7 P2-6 开关语义（双开关）

- `ENABLE_SCHEDULER`（默认 `true`）：API 进程是否启动 APScheduler。**多副本时仅一个副本设 `true`**，防重复触发。
- `SCHEDULED_REPORT_VIA_CELERY`（默认 `true`）：APScheduler 触发后走 `delay()`（Worker）还是 `ThreadPoolExecutor`（原地同步）。
- 组合矩阵如下，必须文档化（见 §11）：

| `ENABLE_SCHEDULER` | `SCHEDULED_REPORT_VIA_CELERY` | 结果 |
| --- | --- | --- |
| `true`（默认） | `true`（默认） | 正常：APScheduler 启动 + `delay()` 走 Worker |
| `true` | `false` | APScheduler 启动但**仍同步跑**（回滚形态，不动代码） |
| `false` | 任意 | APScheduler 不启动，两条路径都不会跑 |

### 4.8 P2-7 `time_limit` 取值验证

- 报告主体 task：`soft_time_limit=600, time_limit=900` **占位**。
- AI 摘要 task：`soft_time_limit=300, time_limit=420` **占位**。
- **实现前必须**跑一次 `scheduled_report_delivery_logs` 的真实耗时（按 `frequency` 分组的 `sent_at - created_at` 的 P50 / P90 / P99）：

  ```sql
  SELECT frequency,
         COUNT(*) AS runs,
         ROUND(AVG(EXTRACT(EPOCH FROM (sent_at - created_at))),1) AS avg_sec,
         ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (sent_at - created_at))),1) AS p90_sec,
         ROUND(MAX(EXTRACT(EPOCH FROM (sent_at - created_at))),1) AS max_sec
    FROM scheduled_report_delivery_logs
   WHERE status = 'sent'
   GROUP BY frequency;
  ```

- 跑出来再调上下限；月度超 15min 是 bug 而非常态。

### 4.9 P2-8 旧路径必须保留（回滚不出代码）

- APScheduler 的 `_dispatch_subscriptions`（`scheduler.py:107`）用 `if SCHEDULED_REPORT_VIA_CELERY:` **分支**：
  - `true` → `dispatch_one_task.apply_async(countdown=i*SPREAD_SECONDS, kwargs=...)`（P1-5 错峰 + P0-1 report_date + P0-2 通过 task 自身护栏）
  - `false` → 原 `ThreadPoolExecutor(... submit(_dispatch_one, ...))` **一行不动**（保留原 `_dispatch_one` 函数原封不动，不重构删除）
- 回滚 = 改 `.env` `SCHEDULED_REPORT_VIA_CELERY=false` + `systemctl restart believeboy-api`，**零代码改动**。

---

## 5. 红线 & 边界

| 绝对红线 | 不能重复发邮件（P0-2 护栏） |
| --- | --- |
| 容忍区 | LLM 重试浪费配额 / `ai_summary_status` 重复推进 / 缓存不同子进程间不共享 / `_dispatch_one` 期间 API 重启丢该任务 |
| 已决不做的 | Redis 跨进程缓存（除非 P1-3 观察显示 DB 压力明显）、迁移 `scheduled_report_*` 数据表、改造 `DeliveryStage` / `DeliveryStatus` 枚举、改前端轮询路径、把 reports worker -Q 加 scheduled |

---

## 6. 落地 Phase

### Phase 1 — 新增 Celery task + 路由 + 队列

- 新建 `backend/app/celery_tasks/scheduled_report.py`：`dispatch_one_task`，主体搬自现有 `_dispatch_one`：
  - `report_date` 作为硬必传参数，task 内禁 `date.today()`；
  - 进入先按 `(sub, freq, report_date, triggered_by)` 行级锁查 `sent_at` 已发则 return（P0-2 / P0-3）；
  - 复用已有 delivery_log（无则通过 `INSERT ... ON CONFLICT DO NOTHING` 创建，唯一约束保证幂等）；
  - `send_*_report_email` 成功**立即** `mark_delivery_success` + `db.commit()`（P0-2）；
  - 末尾 `ai_summary_task.delay(log_id=..., ledger_key=..., override_ai_model=...)`（P2-5）；
  - `acks_late=True, max_retries=3`（与 §10 验收第 5 条对齐：失败任务按 max_retries=3 重试）；`soft_time_limit=600, time_limit=900`（P2-7 占位）。
- 新建 `backend/app/celery_tasks/ai_summary.py`：`generate_delivery_summary`（P2-5 完整实现）。
- 修改 `backend/app/tasks/celery_app.py`：
  - `include` 加 `app.celery_tasks.scheduled_report` + `app.celery_tasks.ai_summary`；
  - `task_routes` 加：

    ```python
    "dispatch_one": {"queue": "scheduled"},
    "generate_delivery_summary": {"queue": "ai_summary"},
    ```

### Phase 2 — APScheduler 触发改造

- `scheduler.py:_dispatch_subscriptions`（107-138）按 4.7 矩阵用 `if SCHEDULED_REPORT_VIA_CELERY:` 分支：
  - `true`：`apply_async(countdown=i*SPREAD_SECONDS, kwargs={..., "report_date": date.today().isoformat()})`；
  - `false`：原 `ThreadPoolExecutor(... submit(_dispatch_one, ...))` **原样保留**。
- `dispatcher.py:dispatch_report_for_subscription`（913-946，手动触发）改为同样走 task（`true` 分支）。

### Phase 3 — P2-7 `time_limit` 数据验证（实现前阻塞）

- 在 VPS 跑 §4.8 的 SQL；
- 根据 P50/P90/P99 数据**调上下限**（实践再确认），不能盲调。

### Phase 4 — systemd 新增 `belieboy-worker-scheduled.service`

- 新增 `backend/deploy/systemd/believeboy-worker-scheduled.service`（参考现有 worker unit 改）：

  ```
  ExecStart=/root/believeboyDashboard/backend/.venv/bin/celery \
            -A app.tasks.celery_app worker \
            -Q scheduled -c 2 --loglevel=info
  ```

- VPS 上 `systemctl daemon-reload && systemctl enable --now believeboy-worker-scheduled`。
- 现有 `belieboy-worker.service` ExecStart 的 `-Q` 改为 `default,reports,insights,ai_summary`（**保持不变即可**——原本就是 `default,reports,insights`，现在加 `ai_summary`）。

### Phase 5 — 配置项

- `backend/app/core/config.py` 新增字段（带 docstring 写清 §4.7 矩阵）：
  - `enable_scheduler: bool = True`
  - `scheduled_report_via_celery: bool = True`
  - `scheduled_dispatch_spread_seconds: int = 60`
  - `max_concurrent_ai_summary: int = 5`
- `backend/.env.example` 补这 4 项及说明（P2-6 / P2-7）。

### Phase 6 — 灰度与回滚（不依赖代码改动）

- **生产灰度建议顺序**：
  1. 部署代码，但 `SCHEDULED_REPORT_VIA_CELERY=false`（旧路径跑，新代码空载）。
  2. 手动验证：API 进程的 `python` 脚本调 `dispatch_one_task.delay(sub_id, report_date)`，查 delivery_logs 正常演进 + 邮件收到 + 截图正常。
  3. `systemctl start believeboy-worker-scheduled`（P1-4 进程）、观察 worker 日志 ok。
  4. 切 `SCHEDULED_REPORT_VIA_CELERY=true` 一次（注意：仅在**一个** API 副本生效）。
  5. 观察 15:00 daily 高峰几轮，验错峰 + 内存 + 邮件正确性。
- **回滚**：
  - `SCHEDULED_REPORT_VIA_CELERY=false` + `systemctl restart believeboy-api`，**秒级**回到原地线程池模式。
  - **broker 积压任务**：回滚前已 `delay()` 进 broker 的消息，会继续被 `belieboy-worker-scheduled.service` 按新代码路径消费完（task body 已部署），不会丢；旧 `_dispatch_one` 仅作为本地线程路径的兜底保留，不参与 broker 任务执行。
  - **回滚后代码依赖图**：`dispatcher.py:_dispatch_one` 函数体**不动**（P2-8），旧分支只走 `_dispatch_one` 内联调用，不再 import 任何 Celery 相关模块，因此和 `app.tasks.celery_app` 解耦，回滚不会引入 import 错误。

---

## 7. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `backend/app/celery_tasks/scheduled_report.py` | **新建**：`dispatch_one_task`（主体搬自 `_dispatch_one`，加 P0-1/P0-2 护栏，P1-5 由外部传入 countdown） |
| `backend/app/celery_tasks/ai_summary.py` | **新建**：`generate_delivery_summary`（P2-5） |
| `backend/app/tasks/celery_app.py` | `include` +2（追加 `app.celery_tasks.scheduled_report` / `app.celery_tasks.ai_summary`）；`task_routes` +2（`dispatch_one` → `scheduled`、`generate_delivery_summary` → `ai_summary`，统一短名对齐现有 `generate_insight` 风格） |
| `backend/app/core/scheduler.py` | `_dispatch_subscriptions` 改为 `if SCHEDULED_REPORT_VIA_CELERY:` 双分支；保留旧路径**一行不动**（P2-8） |
| `backend/app/services/scheduled_report/dispatcher.py` | `dispatch_report_for_subscription` 改为走 `delay()`（仅 `true` 分支用）；**`_dispatch_one` 函数体不动**（P2-8 回滚安全网） |
| `backend/app/services/scheduled_report/ledger_service.py` | `resend_ledger_entry_async` 把 `threading.Thread(...)` 改为 `dispatch_one_task.delay(...)`（与 §1.1 补发链路对应；并轨到主 task 复用 P0-1/P0-2/P0-3 护栏） |
| `backend/app/core/config.py` | 新增 4 个配置字段（带组合矩阵 docstring）；`max_concurrent_ai_summary` 带 Pydantic 校验 `ge=1, le=20`（见 §4.6 决策实现注意） |
| `backend/.env.example` | 补 4 个配置项说明 |
| `backend/deploy/systemd/believeboy-worker-scheduled.service` | **新建**：`scheduled` 独立 worker unit |
| `backend/deploy/systemd/believeboy-worker.service` | `-Q` 增加 `ai_summary`：`default,reports,insights,ai_summary` |

**不改动**（除 P0-3 外）：`DeliveryStage` 状态机 / 前端轮询 / `report_builder_*` / `email_sender_*` / `screenshot.py` 业务实现 / `_dispatch_one` 函数体。**注意**：本方案新增一条 alembic 迁移（见 P0-3），为 `scheduled_report_delivery_logs` 表加唯一约束 `(subscription_id, frequency, report_date, triggered_by)` ——属于"表结构"调整，与本节"不改动"互为表里，需随 alembic 一并出。

---

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Worker 环境 chromium 缺失 → 截图全失败 | Playwright 已在生产配好（用户确认）；实现后跑一次手动 `dispatch_one_task.delay(sub_id)` 冒烟验证截图产出 |
| AI 摘要 `time_limit=420s` 偏紧 | Phase 3 实现前跑 `delivery_logs` 真实耗时按需调 |
| `scheduled` 进程 `-c 2` 处理 11 个 daily 积压耗时过长 | P1-5 countdown 错峰把高峰拉成 10 分钟，均衡负载 |
| task 重试副作用扩散 | P0-2 承重墙护栏（开头 skip sent_at 已发）+ LLM 浪费可接受 |
| API 多副本上线后重复触发 | `ENABLE_SCHEDULER` 仅一个副本 `true`（P2-6）；task 内幂等检查也兼容 |
| 旧路径回滚被代码重构掉 | `_dispatch_one` 函数 + 旧分支**原样保留**（P2-8 实施方案禁忌） |
| monthly report 真实耗时 > 15min 触顶 900s | Phase 3 数据先看；超时即软杀后重试，**这是 bug 不应静默接受**，需 alert |
| 多 worker 进程下 APScheduler 多实例同时触发 | `deployment-runbook.md` 规划 API `--workers 4`（uvicorn/gunicorn 风格），每个 worker 进程独立内存、lifespan 各自跑一次 `init_scheduler()`（`main.py:108`），意味着 4 个 BackgroundScheduler 各自到点 `delay()` 进 broker，把同分钟内 N 订阅各派 4 份。**`ENABLE_SCHEDULER=false` 仅能管多副本去重，管不了单副本内多 worker 进程**。缓解：本次灰度阶段保留 `--workers 1`；启用 multi-worker 时必须把 `ENABLE_SCHEDULER` 切到 `false`（由外部 cron / systemd timer 取代），并写进 deployment-runbook |

---

## 9. 测试策略

1. **单测**：抽离 `_dispatch_one` 的核心为可单测函数 `dispatch_one_core(...)`（避免对模块全局状态的硬依赖），复用现有 `tests/services/scheduled_report/*` 测试用例。
2. **集成**（手动）：
   - `dispatch_one_task.delay(sub_id, report_date='2026-07-10')` → 查 `delivery_logs.stage` 演进 + 邮件 + R2 截图；
   - 故意制造 broker 堆积（如先 stop worker、`delay()` 多次）→ worker 起来后顺序消费且不重复发邮件（P0-2 验证）。
3. **重试**：kill worker 中途，broker 重投后验证：邮件只发一次。
4. **压测**：复用 `backend/scripts/test_schedule_stress_1000.py` 验证 countdown 错峰路径下的并发与吞吐。
5. **回归**：`jobs` / `ai_insights` / 手动 `monthly-reports` 端到端不受影响。

---

## 10. 验收标准

- [ ] 定时报告经 `scheduled` 队列执行（`journalctl -u believeboy-worker-scheduled` 可见 `dispatch_one` 日志）。
- [ ] 11 个 daily 订阅 15:00 触发时，broker 消息带 `countdown=i*60` 错峰（验证 worker 日志 / broker 工具）。
- [ ] `scheduled_report_delivery_logs.stage` / `status` 演进与迁移前一致，前端轮询无感。
- [ ] API 日志中**不再出现** `Report sent` 同步打印（移到了 worker 日志）。
- [ ] 失败任务按 `max_retries=3` 重试，**邮件只发一次**。
- [ ] API 重启不丢在途报告（broker 持久化）。
- [ ] `SCHEDULED_REPORT_VIA_CELERY=false` 时回到原 `ThreadPoolExecutor` 路径。
- [ ] `ENABLE_SCHEDULER=false` 的 API 副本不触发扫描。
- [ ] `ai_summary` 队列与定时洞察资源互不干扰（独立信号量 5）。
- [ ] 截图内存峰值不再影响 `reports` worker（`scheduled` 独立进程）。

---

## 11. 配置项清单（实现后 `backend/.env.example` 必须有）

```bash
# 是否在当前 API 进程启动 APScheduler。多副本时只在一台设 true，其余设 false。
# ENABLE_SCHEDULER=true

# true: APScheduler 触发后把消息 delay() 进 broker，报告在 Celery worker 执行。
# false: APScheduler 用 ThreadPoolExecutor 在 API 内同步执行（回滚形态）。
# SCHEDULED_REPORT_VIA_CELERY=true

# 同一分钟触发的多个订阅，错峰派发间隔（秒）。i 从 0 起，第 i 个延迟 i×SPREAD 秒
# （默认 60s 时 → 第 1 个 0s、第 2 个 60s、第 3 个 120s ……）。
# SCHEDULED_DISPATCH_SPREAD_SECONDS=60

# ai_summary 队列的 LLM 并发信号量上限。和 generate_insight 的 3 互不影响。
# MAX_CONCURRENT_AI_SUMMARY=5
```

`ENABLE_SCHEDULER` / `SCHEDULED_REPORT_VIA_CELERY` 组合语义在 config 字段 docstring 中复述一遍。

---

## 12. 后续文档更新

- `backend/docs/multi-worker-ops.md`：新增 `scheduled` 与 `ai_summary` 队列说明、堆积阈值、OOM 处置。
- `docs/REFERENCE.md`：Background Jobs 段更新——`scheduled_report` 现走 Celery `scheduled` 队列，APScheduler 仅做定时器。
- `docs/deployment-runbook.md`：补充 APScheduler 多实例去重（`ENABLE_SCHEDULER`）说明。
- `docs/superpowers/`（本目录）：实现完成后回头补一份"实现回顾"，记录与 frozen 方案的偏差与原因。
- `docs/deployment-runbook.md`：补充 unicorn `--workers > 1` 与 `ENABLE_SCHEDULER=false` 的强制组合规则（M7 风险缓解）。
