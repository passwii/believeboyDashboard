# Deployment Runbook

## API 横向扩容 SOP

适用场景：月报任务状态已迁移到 `Job` / `JobRun` 后，需要对 FastAPI 做 `uvicorn --workers N` 横向扩容。

1. 确认后台 Celery worker 已运行：
   ```bash
   systemctl status believeboy-worker.service
   celery -A app.tasks.celery_app inspect ping
   ```

2. 在 staging 将 API 进程数调整到 4：
   ```bash
   cd backend
   uvicorn app.main:app --host 0.0.0.0 --port 8100 --workers 4
   ```

3. 创建一条月报任务并确认创建接口立即返回 `job_id`：
   ```bash
   curl -sS -X POST "${API_URL}/api/v1/monthly-reports" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: ${API_KEY}" \
     -d '{"project_name":"测试项目","country":"US","report_month":"2026-06","transaction_file_id":"txn.csv"}'
   ```

4. 轮询状态接口，确认任意 API worker 都能从数据库读到同一任务状态：
   ```bash
   curl -sS "${API_URL}/api/v1/monthly-reports/tasks/${JOB_ID}"
   ```

5. 跑 5 分钟饱和压测：
   ```bash
   cd backend/stress_test
   k6 run k6_baseline.js
   ```

6. 验收标准：
   - `GET /api/v1/monthly-reports/tasks/{job_id}` 不出现跨 worker 404
   - `GET /api/v1/monthly-reports/tasks/{job_id}/result` 在任务成功后可下载
   - 重启任意 API worker 后，同一 `job_id` 仍能读到状态
   - `k6 saturation_50vu` 5 分钟 p99 < 5s

7. 生产发布：
   - 先在 staging 完成上述验证
   - 灰度 1 台生产 API 到 `--workers 4`
   - 观察 15 分钟无 404/500 增长后，再全量切换
   - 保持 Celery worker 并发度由 `believeboy-worker.service` 的 `--concurrency=4` 控制

## APScheduler 多实例去重（BEL-NEW：切片 3 / M7）

> **新增段落** — 定时报告每分钟由 APScheduler 扫描订阅、与方案 `2026-07-10-
> scheduled-report-to-celery.md §1.3 / §4.7` 强相关。

`uvicorn --workers N > 1` 时，**每个 worker 进程独立内存**、`@app.on_event("startup")`
各自跑一次 `init_scheduler()`——意味着 N 个 `BackgroundScheduler` 实例会
**各自每分钟触发派发**，把同一份订阅集合拉成 N 份。Celery 的 P0-3 唯一约束
挡得住数据库写入重复，但** broker 上的任务消息会膨胀 N 倍**，对 worker 来说
是**纯浪费 + 重复工**。

**约束**：

| 部署形态 | `ENABLE_SCHEDULER` | `SCHEDULED_REPORT_VIA_CELERY` |
|---|---|---|
| 单 API 进程 / 单 worker 进程（当前 production） | `true` | `true` |
| 多 API 副本（同机或跨机）| **仅 1 副本设 `true`** | `true` |
| 启用 uvicorn `--workers > 1` | **`false`**（强制） | `true` 仍 OK（任务来自 APScheduler 还活的副本）|
| 紧急回滚 | `false` 即可暂停调度 | `false` 即可立刻回到 ThreadPoolExecutor 同步派发 |

**实施步骤（启用 uvicorn `--workers 4` 时）**：

1. 在 `backend/.env` 把 `ENABLE_SCHEDULER=false`。
2. 部署新代码并 `systemctl restart believeboy-api`。
3. （可选）用外部 cron / systemd timer 取代 APScheduler，保证 1 个 leader
   跑扫描；其它副本只跑 API。
4. 不用动 `SCHEDULED_REPORT_VIA_CELERY`：它仍走 Celery。

> **不允许** 把 `ENABLE_SCHEDULER` 与 `SCHEDULED_REPORT_VIA_CELERY` 的
> 组合矩阵写入自动化 deploy script：人工每次确认。

参考：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md` §1.3 / §4.7 / §8（风险表"M7 多 worker 进程下 APScheduler 多实例同时触发"）。
