# Backend (FastAPI)

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# .env 已随仓库一起提交（仓库为私有）。本机首次拉分支后若没有 .env，
# 跑 `git pull` 同步，或从其他 worktree 拷贝 `backend/.env` 即可。
```

`backend/.env` 用于后端自己的运行配置，其中 `DATABASE_URL`、`PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 都只应保留在后端，不应放到前端的 `.env.local`。`AI_CHAT_PROVIDER_BASE_URL`、`AI_CHAT_PROVIDER_API_KEY`、`AI_CHAT_DEFAULT_MODEL`、`AI_CHAT_MODEL_ALLOWLIST`、`AI_CHAT_TIMEOUT_SECONDS` 也统一放在后端。`DATABASE_URL` 现在是必填项，未配置时后端和 Alembic 会直接报错，不再回退到本地 SQLite。

> **2026-06-13 变更**：`.env` 现已加入 git 跟踪（仓库已私有化），所有 worktree 切分支时 `git pull` 即可同步。`API_KEY` 等敏感变量随仓库走。

## Run API

```bash
./run_api.sh
```

Jobs are executed in background one-off Python processes (no Redis required in current mode).

Redis recovery plan: see [`REDIS_PLAN.md`](./REDIS_PLAN.md).

## Migrations

```bash
alembic upgrade head
```

## Import BLF Basic Info CSV

```bash
cd backend
python scripts/import_blf_basic_info.py
```

Custom file path:

```bash
cd backend
python scripts/import_blf_basic_info.py --file=/absolute/path/to/BLF_Basic_Info.csv
```

## Create Projects Table (PostgreSQL)

```bash
cd backend
python scripts/create_projects_table.py
```

## Import Projects CSV

```bash
cd backend
python scripts/import_projects.py
```

Custom file path:

```bash
cd backend
python scripts/import_projects.py --file=/absolute/path/to/projects.csv
```

## Init + Import Projects (Recommended)

```bash
cd backend
python scripts/init_and_import_projects.py
```

Custom file path:

```bash
cd backend
python scripts/init_and_import_projects.py --file=/absolute/path/to/projects.csv
```

## Create User Accounts Table (PostgreSQL)

```bash
cd backend
python scripts/create_user_accounts_table.py
```

## Seed Admin User (PostgreSQL)

```bash
cd backend
python scripts/seed_admin_user.py
```

Note:

- Default behavior does not reset password for an existing admin email.
- Add `--reset-password` only when you want to rotate password.

Custom admin:

```bash
cd backend
python scripts/seed_admin_user.py --name=yawei --email=yawei@believeboy.com --password='XeonJJ2024@'
```

Force reset password:

```bash
cd backend
python scripts/seed_admin_user.py --email=yawei@believeboy.com --password='XeonJJ2024@' --reset-password
```

## Init User Accounts + Seed Admin (Recommended)

```bash
cd backend
python scripts/init_user_accounts.py
```

Force reset password while initializing:

```bash
cd backend
python scripts/init_user_accounts.py --email=yawei@believeboy.com --password='XeonJJ2024@' --reset-password
```

## Auth

- All `/api/v1/*` except `/api/v1/health` require `X-API-Key`.

## Services Architecture

The backend services layer has been restructured into subpackages for better organization and maintainability:

```
app/services/
├── ad/                    # Advertising analysis
├── ai/                    # AI chat and insights
├── category/              # Category research
├── daily/                 # Daily analysis reports
├── data/                  # Data management (costs, exchange rates, projects)
├── digital/               # Digital employees
├── financial/             # Financial reports and payment validation
├── infra/                 # Infrastructure (Redis, jobs)
├── inventory/             # Inventory analysis and replenishment
├── payment/               # Payment report parsing
├── pricing/               # Pricing calculations
├── product/               # Product analysis
├── report/                # Monthly report generation
├── shipment/              # Shipment scheduling
├── category_research_service.py    # [deprecated] Category research compat layer
├── monthly_report_service.py       # [deprecated] Monthly report compat layer
└── ...                    # Other legacy services
```

### Importing Services

New code should import directly from subpackages:

```python
# ✅ Recommended (new style)
from app.services.inventory.replenishment import list_snapshot_options
from app.services.payment import validate_payment_report_project_match
from app.services.report.monthly import get_financial_series

# ⚠️ Legacy (backward compatible, but deprecated)
from app.services.inventory_replenishment_service import ...
```

Backward compatibility is maintained through legacy service files that re-export from subpackages. These compatibility layers show deprecation warnings but remain functional.

### Running Tests

```bash
# All tests
pytest tests/ -v

# Specific service tests
pytest tests/services/report/ -v
pytest tests/services/ad/ -v
pytest tests/services/category/ -v
```

## Systemd (VPS)

```bash
cd backend
./scripts/systemd-install.sh
```

## ⚠️ 单进程约束（单 API 进程 / 单 Worker 进程）

> **生产部署禁止把 `uvicorn --workers N` 设为 `N > 1`。** 在多 worker 架构（BEL-55）落地之前，API 必须保持单进程。

**原因**：当前任务状态由 **进程内模块级 dict** 维护：

- `app/services/job_service.py` 里的 `enqueue_job` 起的 `daemon=True` 线程
- `app/services/monthly_report_runtime_service.py` 的 `MonthlyReportTask` 内存表（`_TASKS`）
- `app/api/v1/endpoints/ai_insight.py` 的 `_insight_queues` 内存表
- `app/services/insight_schedule_service.py` 的 `_insight_semaphore(3)` 进程内信号量

这些结构在 N 个 uvicorn 进程下各有独立副本，**`POST /jobs` 落到 worker A 起的线程，`GET /jobs/{id}` 落到 worker B 拿到 404**，是横向扩容 API 时的潜伏 P0 bug。

**约束的解除条件**：BEL-55 完成后，任务状态全部落到 `Job` / `JobRun` 数据库行，dispatch 改为 `celery -A app.tasks.celery_app worker`（见 BEL-55-P0 引入的 worker systemd 单元），所有进程/机器看到一致视图。

**Celery worker 进程的并发度**由 systemd 单元的 `--concurrency=4` 控制，**不要**通过 `celery multi` 在同一台机器上启多份 worker（除非先确认 broker 上的任务已经设计为可重入）——见 BEL-55-P0 引入的 `believeboy-worker.service`。
