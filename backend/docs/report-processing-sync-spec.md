# 报表处理与同步规范（前端快响应 / 后端后台同步）

更新时间：2026-02-27

## 1. 目标
- 前端点击生成后，接口必须快速返回（不等待数据库写入）。
- 报表文件生成完成后立即可下载。
- 所有数据库相关持久化均在后端后台线程执行，不阻塞前端交互。

## 2. 统一原则
- 创建接口只做：参数校验 + 任务创建 + 返回 `task_id` 与轮询/下载端点。
- 任务状态统一使用：`pending / running / success / failed`。
- 前端只轮询“任务状态端点”，不依赖数据库表写入完成。
- 后台持久化失败不影响已生成文件下载，但要在状态中明确暴露失败信息。

## 3. API 约定
### 3.1 月报
- `POST /api/v1/monthly-reports`
  - 返回：`job_id(task_id)`、`status_endpoint`、`result_endpoint`、`status`
- `GET /api/v1/monthly-reports/tasks/{task_id}`
  - 返回：任务进度 + `persistence_status`（后台数据库同步状态）
- `GET /api/v1/monthly-reports/tasks/{task_id}/result`
  - 任务成功后下载文件

### 3.2 日报
- `POST /api/v1/daily-reports`
  - 返回：`job_id(task_id)`、`status_endpoint`、`result_endpoint`、`status`
- `GET /api/v1/daily-reports/tasks/{task_id}`
- `GET /api/v1/daily-reports/tasks/{task_id}/result`

### 3.3 产品分析
- `POST /api/v1/product-analysis-reports`
  - 返回：`job_id(task_id)`、`status_endpoint`、`result_endpoint`、`status`
- `GET /api/v1/product-analysis-reports/tasks/{task_id}`
- `GET /api/v1/product-analysis-reports/tasks/{task_id}/result`

## 4. 运行时任务模型
- 任务存储在后端内存（runtime task store）。
- 任务完成（`success/failed`）后保留 24 小时，超时自动清理（TTL）。
- 状态字段：
  - `stage`: 当前阶段
  - `progress`: 0-100
  - `message`: 前端展示文案
  - `error_message`: 失败原因
  - `result_path`: 结果文件路径（仅 success）

## 5. 月报后台同步（数据库）
- 月报任务成功后先返回下载能力（`success`）。
- 后台独立线程执行数据库写入：
  - `monthly_reports`
  - `monthly_report_transactions`
  - `monthly_report_pt3_calculation`
  - `monthly_report_pt4_calculation`
- 同步状态通过 `persistence_status` 暴露：
  - `idle / running / success / failed`

## 6. 前端实现要求
- 生成后优先使用创建接口返回的 `status_endpoint`/`result_endpoint`。
- 任务 `success` 后立即触发下载，不等待后台持久化。
- 月报页面需展示“后台同步中/完成/失败”徽标。
- 重试下载不触发重新生成。

## 7. 回归检查清单
- 创建接口响应耗时是否稳定在秒级内（关注响应头耗时拆解）。
- 报表成功后是否可立即下载。
- 前端关闭页面后，后端是否继续完成后台同步。
- TTL 到期后，运行时任务是否自动清理。
