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
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
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
