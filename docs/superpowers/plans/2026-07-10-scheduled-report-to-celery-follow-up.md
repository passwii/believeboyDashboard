# 方案 follow-up：定时报告迁移至 Celery（灰度期执行状态 + 待验证项）

- **对应方案**：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md`（frozen，9 决策已闭环）
- **本文档状态**：阶段性记录（implementation tracker，非 frozen 方案）
- **生成日期**：2026-07-11
- **下一步责任人**：Damon（生产灰度验证 + 高峰观察 + 反馈）
- **关联 commits**（feat/scheduled-celery → main fast-forward merge）：
  - `fb3581b8` feat(定时报告): P0-3 加 supersede 历史重复 + 配置项基础（切片 1）
  - `22813e99` feat(定时报告): 切片 2，dispatch_one_task + ai_summary task + 独立信号量桶
  - `4acab2a9` feat(定时报告): 切片 3，scheduler / 手动 trigger / resend 三入口走 Celery
  - `0eec7713` feat(部署): 切片 4，scheduled worker systemd unit 与三处 docs 同步
  - `f6dfeb7b` 合并：定时报告迁移至 Celery（切片 1-4 + 修正）
  - `29cd2a35` fix(迁移): P0-3 partial unique index 替代全 unique constraint（P0-3 v2 修订）

---

## 1. 已经做的（实施完成 ✅）

### 1.1 代码 / 数据迁移

| 项 | 内容 | 文件 / 验证点 |
|---|---|---|
| 模型 | `DeliveryStatus.SUPERSEDED` 加进 enum | `backend/app/models/scheduled_report.py:27` |
| 模型 | `Index("uq_delivery_log_dedup", ..., unique=True, postgresql_where=status NOT IN ('superseded','failed'))`（P0-3 v2 partial unique） | 同上 `__table_args__` |
| 配置 | 4 个新 env vars | `backend/app/core/config.py` + `backend/.env.example` |
| Celery task | `dispatch_one`（name alias，队列 `scheduled`，acks_late=True，max_retries=3，soft=300/time=420） | `backend/app/celery_tasks/scheduled_report.py` |
| Celery task | `generate_delivery_summary`（队列 `ai_summary`，独立信号量桶，max_retries=2，soft=120/time=240） | `backend/app/celery_tasks/ai_summary.py` |
| 路由 | `dispatch_one → scheduled`、`generate_delivery_summary → ai_summary`（与 `generate_insight` 短名风格对齐） | `backend/app/tasks/celery_app.py` |
| 信号量桶 | `acquire_remote_semaphore` 按 name 分桶：`insights` → `max_concurrent_insights`，`ai_summary` → `max_concurrent_ai_summary`（解 M2 bug） | `backend/app/services/insight_concurrency.py` |
| 触发迁移 | `scheduler._dispatch_subscriptions` 加 `SCHEDULED_REPORT_VIA_CELERY` 双分支（true 走 `apply_async(countdown=i*SPREAD_SECONDS, ...)`；false 旧路径 ThreadPoolExecutor 一行不动） | `backend/app/core/scheduler.py` |
| 触发迁移 | `dispatcher.dispatch_report_for_subscription` 同样的双分支（true 走 `delay()` 返 task_id；false 一行不动） | `backend/app/services/scheduled_report/dispatcher.py:988` |
| 触发迁移 | `ledger_service.resend_ledger_entry_async` 改 `dispatch_one_task.delay(..., pre_existing_log_id=log.id)` | `backend/app/services/scheduled_report/ledger_service.py:536` |
| Body 共享 | `_dispatch_one_task_body` 抽函数，与 `_dispatch_one` 共享主体（旧路径与新 task 字节一致） | `backend/app/services/scheduled_report/dispatcher.py` |
| Body 入参 | `pre_existing_log_id=None`（resend 路径复用 caller 已创建的 log，跳过 CREATE） | 同上 |
| alembic | `20260710_210_add_superseded_status_and_unique_constraint.py`：先把 119 行历史重复标 `superseded` + `error_message` 追加 `legacy duplicate of log_id=<min>` 痕跡；再加 partial unique index | `backend/alembic/versions/20260710_210_*` |

### 1.2 部署形态

| 项 | 内容 |
|---|---|
| systemd unit | `belief-worker-scheduled.service`（新建）—— `-Q scheduled -c 2`，Playwright 截图内存隔离 |
| systemd unit | `believey-worker.service`（修改）—— `-Q` 加 `ai_summary`：`default,reports,insights,ai_summary` |
| `.env` | 4 个开关已写入 `backend/.env`，**当前 `SCHEDULED_REPORT_VIA_CELERY=false`**（旧路径跑 + 新代码空载）|

### 1.3 文档同步

| 文件 | 改动 |
|---|---|
| `docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md` | frozen 方案 M1-M7 + S1-S4 评审修订已落地 |
| `docs/REFERENCE.md` | Background Jobs 段：补 scheduled worker + 触发流程 + SCHEDULED_REPORT_VIA_CELERY 回滚矩阵 |
| `backend/docs/multi-worker-ops.md` | systemd 单元表加 scheduled 行；队列堆积阈值表加 scheduled / ai_summary |
| `backend/docs/deployment-runbook.md` | 新增"APScheduler 多实例去重（BEL-NEW：切片 3 / M7）"段 |

### 1.4 单测 / 数据基线

| 项 | 状态 |
|---|---|
| 新单测（切片 1-5 累计）| **58/58 绿**：`test_delivery_log_dedup.py` + `test_scheduled_report_celery.py` + `test_slice3_trigger_paths.py` |
| P50/P90/P99 真实耗时（§4.8）| daily P99=185s / weekly=130s / monthly=103s —— 推导 `soft=300/time=420`（主体 task）+ `soft=120/time=240`（AI 摘要 task）|
| 数据基线 | production BLF 664 行（sent 519 / failed 21 / pending 5 / superseded 119）|
| partial unique index | `uq_delivery_log_dedup` 已建：`WHERE (status NOT IN ('superseded', 'failed'))` |

### 1.5 已知 1 个方案修订（不破坏 frozen 文档）

**P0-3 v2：partial unique index 替代全 UniqueConstraint**

- 原方案：`UniqueConstraint(subscription_id, frequency, report_date, triggered_by)` —— 创建时因历史 119 行重复而 `UniqueViolation`
- 修订：`Index(..., unique=True, postgresql_where=status NOT IN ('superseded','failed'))` —— 只对未来 active 行 enforce unique
- 行为差异：
  - 历史 `sent` 行仍可存在（已 supersede + error_message 标记 min_id 痕跡）
  - 未来 INSERT 同一 `(sub, freq, date, triggered_by)` 行（status 为 pending / preparing / sending / done）会被 unique 挡掉——P0-3 race 防护目的仍达成
  - 未来 `failed` 状态行可重复插入（人工重试场景不被 unique 卡住）
- commit：`29cd2a35`
- 影响范围：`backend/app/models/scheduled_report.py`、`backend/alembic/versions/20260710_210_*`、测试 3 个 assert 更新

---

## 2. 待你跑的（灰度验证 ⏳）

### 2.1 冒烟一次（推荐先做，10 分钟内可验证）

```bash
ssh root@145.79.143.98 "
  cd /root/believeboyDashboard/backend
  source .venv/bin/activate
  # 真触发一次任务（不依赖 APScheduler 时机）
  python - <<'PY'
  from app.core.config import get_settings
  from datetime import date
  from app.celery_tasks.scheduled_report import dispatch_one
  from app.db.session import SessionLocal
  from app.models.scheduled_report import ScheduledReportSubscription

  db = SessionLocal()
  try:
      sub = db.query(ScheduledReportSubscription).filter_by(enabled=True).first()
      if sub is None:
          print('no enabled subscription'); raise SystemExit(0)
      print(f'sub #{sub.id} country={sub.country} freq={sub.frequency}')
      result = dispatch_one.delay(
          subscription_id=sub.id, email=sub.email or 'smoke@example.com',
          project_ids=sub.project_id_list, country=sub.country,
          frequency=sub.frequency, ai_model=getattr(sub, 'ai_model', None),
          triggered_by='auto', report_date=date.today().isoformat(),
      )
      print(f'task_id: {result.id}')
      out = result.get(timeout=90, propagate=False)
      print('Result:', out)
  finally:
      db.close()
  PY
"
# 期望：result['status'] == 'enqueued' 或 'completed' 或 'skipped_already_sent'
```

冒烟通过 → 走 §2.2。

### 2.2 切到 Celery 路径（10 秒可切 / 10 秒可回）

```bash
ssh root@145.79.143.98 "
  cd /root/believeboyDashboard/backend
  sed -i 's|^SCHEDULED_REPORT_VIA_CELERY=false|SCHEDULED_REPORT_VIA_CELERY=true|' .env
  grep SCHEDULED_REPORT_VIA_CELERY .env
  systemctl restart believeboy-api
"
```

从这一刻起，APScheduler 触发的派发全部走 Celery `dispatch_one_task.apply_async(countdown=i*60)`。

### 2.3 高峰观察（至少 1 个 daily 周期，建议 3 个）

```bash
# 15:00 daily 触发后跑这些
ssh root@145.79.143.98 "
  # worker 日志
  journalctl -u believeboy-worker-scheduled -n 200 --no-pager | tail -50
  journalctl -u believeboy-worker -n 100 --no-pager | tail -30

  # API 日志（应不再出现 'Report sent' 同步打印）
  journalctl -u believeboy-api -n 200 --no-pager | grep -i 'Report sent' | tail

  # broker 队列长度
  redis-cli -n 1 LLEN scheduled
  redis-cli -n 1 LLEN ai_summary

  # OOM 检查
  journalctl -u believeboy-worker-scheduled --since '1 hour ago' | grep -iE 'oom|killed|memory'
  dmesg -T | grep -i 'killed process.*celery' || echo 'no oom kills'

  # 邮件重复检测
  sudo -u postgres psql -d BLF -c \"
    SELECT report_date, COUNT(*) AS rows
      FROM scheduled_report_delivery_logs
     WHERE created_at > NOW() - interval '1 hour'
       AND triggered_by = 'auto'
     GROUP BY report_date
     HAVING COUNT(*) > 1
     ORDER BY report_date DESC LIMIT 10;
  \"
"
```

### 2.4 收集指标 + 反馈

把以下指标贴回给 agent：

| 类别 | 数据点 |
|---|---|
| 错峰 | 11 个 daily 触发后 broker 内首尾任务 timestamp 差（应 ≈ 10 分钟：0/60/120/.../600s）|
| worker 内存 | scheduled worker `Memory:` 字段（应 ≤ 1.5 GB 峰值；与 reports worker 解耦）|
| 邮件收到 | 高峰 N 次触发、订阅数 M、实际收到 N×M 件（**每订阅每天 ≤ 1 件**）|
| ai_summary 队列峰值 | `LLEN ai_summary` 在高峰内最大值（应 ≤ 5） |
| delivery_log 重复检测 | 上述 SQL 不应有"同 report_date 多于 1 行 auto" |
| OOM | 日志里 `MemoryError` / `Killed` 计数（应为 0）|
| API 日志变化 | `Report sent` 同步打印从 API 日志消失（迁到 scheduled worker 日志）|

---

## 3. 灰度 / 回滚（10 秒可回）

### 3.1 回滚形态（P2-8 安全网）

```bash
ssh root@145.79.143.98 "
  cd /root/believeboyDashboard/backend
  sed -i 's|^SCHEDULED_REPORT_VIA_CELERY=true|SCHEDULED_REPORT_VIA_CELERY=false|' .env
  systemctl restart believeboy-api
"
```

回滚后：
- APScheduler 下一次触发立刻走 `_dispatch_one`（旧 ThreadPoolExecutor 路径，与本方案前字节一致）
- broker 已 `delay()` 进 `scheduled` 队列的消息继续由 `belief-worker-scheduled.service` 按新代码消费完，**不丢**（但如果 broker 内 N 条任务已发，回滚后 N 条都按新代码跑 = 完成 P0-1/P0-2/P0-3 护栏 + 邮件）
- `_dispatch_one` 函数体一行不动（verified at deploy-time `git diff`）

### 3.2 全停派发（紧急）

```bash
sed -i 's|^ENABLE_SCHEDULER=true|ENABLE_SCHEDULER=false|' /root/believeboyDashboard/backend/.env
systemctl restart believeboy-api
```

`ENABLE_SCHEDULER=false` 时 `init_scheduler()` 跳过 `BackgroundScheduler.start()`，APScheduler 不再触发派发。Celery task 仍在 worker 端可消费，但不再有新任务入队。

### 3.3 多副本 / 多 worker 进程的强制组合（M7）

如果以后启用 `uvicorn --workers N > 1`，**必须** `ENABLE_SCHEDULER=false` —— 见 `backend/docs/deployment-runbook.md` §"APScheduler 多实例去重"段，方案 §1.3 / §4.7 / §8（风险表 M7）。

---

## 4. 验收对照（方案 §10 10 条）

| # | 验收点 | 当前状态 |
|---|---|---|
| 1 | 定时报告经 `scheduled` 队列执行（journalctl 见 `dispatch_one` 日志）| ⏳ 等 G2 切 true 后观察 |
| 2 | 11 个 daily 触发时 broker 消息带 `countdown=i×60` 错峰 | ⏳ 同上 |
| 3 | `delivery_logs.stage / status` 演进与迁移前一致，前端轮询无感 | ⏳ 同上 |
| 4 | API 日志不再出现 `Report sent` 同步打印 | ⏳ 同上 |
| 5 | 失败任务按 `max_retries=3` 重试，邮件只发一次 | ⏳ 同上（关键：P0-3 partial unique 已落）|
| 6 | API 重启不丢在途报告 | ✅ broker 持久化；apscheduler restart 期间 broker 已 delay 的消息会被新启动的 scheduled worker 消费 |
| 7 | `SCHEDULED_REPORT_VIA_CELERY=false` 时回到 ThreadPoolExecutor 路径 | ⏳ 待人工验证（推荐 G3 后做一次演练）|
| 8 | `ENABLE_SCHEDULER=false` 的 API 副本不触发扫描 | ⏳ 同上 |
| 9 | ai_summary 队列与定时洞察资源互不干扰（独立信号量 5）| ✅ `_LIMIT_BY_NAME` 映射在 `acquire_remote_semaphore`（`backend/app/services/insight_concurrency.py`）|
| 10 | 截图内存峰值不再影响 reports worker（scheduled 独立进程）| ⏳ 等 G2 观察 worker 内存峰值 |

---

## 5. 已知 / 已知无关 follow-up

### 5.1 与本方案无关的 baseline 烂 test（独立 PR）

| 项 | 状态 |
|---|---|
| `tests/services/scheduled_report/test_context_helpers.py` 7 个 fail | Base 问题：`r2_delete_failures.context_json` 是 PG `JSONB`，SQLite in-memory 不能编译 |
| `tests/tasks/test_celery_app_config.py` 6 个 fail | Base 问题：pydantic Settings `database_url` Field required（测试 fixture 没填）|
| `tests/services/scheduled_report/test_report_builder_weekly.py` 等 cascading errors | 接上面两个 fixture 失败 cascade |

切片 1-5 没触碰这块。**修法**：
- `test_context_helpers.py`：换成 PG fixture（docker / 测试 PG 实例），或为 SQLite 改用 `JSON` 类型（语义略变）
- `test_celery_app_config.py`：测试前 conftest fixture 给关键 env var 默认值

### 5.2 后续 follow-up（建议独立 PR）

1. **回填方案 §12 实现回顾**：等 G3 高峰跑过 + 数据有反馈后，把"实际 vs frozen 方案"偏差汇总（已确定要写的：partial unique index 修订、`Scheduler.max_workers = min(N, 8)` 仍保留、`enqueue_ai_summary_generation` 同步迁 task 等）
2. **base test fixture 修**（见 5.1）
3. **多 worker 进程实施**：`deployment-runbook.md` 已规划 `uvicorn --workers 4`，启用时强制 `ENABLE_SCHEDULER=false`
4. **Worker 横向扩展**：方案 §3 非目标。当前 scheduled 1 进程 `-c 2`；如果未来 daily 数 > 30，再考虑 `celery multi`

---

## 6. 反馈模板（贴回 agent）

```
=== [必须] 灰度状态 ===
时间：YYYY-MM-DD HH:MM
是否切 SCHEDULED_REPORT_VIA_CELERY=true：是 / 否（保留 false 阶段）
已观察高峰周期数：N
broker 错峰（首尾 timestamp 差）：__s
scheduled worker 内存峰值：__MB
ai_summary 队列峰值长度：__
邮件收到件 / 期望件：__ / __
delivery_log auto 重复行检测：__ 行（应 0）
OOM 计数：__（应 0）

=== [可选] 异常与发现 ===
<粘贴 journalctl / psql / dmesg 摘录>

=== [可选] 偏差与决策 ===
<实际 vs frozen 方案的差异>
```

---

## 7. 链路索引

- **frozen 方案**：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md`
- **实施回顾（待写）**：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery-implementation-review.md`（等 G3 后由 agent 起）
- **本 follow-up**：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery-follow-up.md`（本文档）
- **代码基线**：main HEAD = `29cd2a35`（P0-3 partial unique 修订）+ `f6dfeb7b`（合并 commit）
- **agent-context**：`/Users/damon/DamonProjects/believeboyDashboard/.agent-contexts/scheduled-celery-execution/baseline.md`（前置记录）