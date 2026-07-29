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

> **2026-07-02 变更**：`.env` 已从 git 追踪移除并加入 `.gitignore`（之前 2026-06-13 加入追踪是误判，仓库虽然私有化但 .env 不该入库）。`.env.example` 仍是模板，新成员按它填写。敏感变量（API_KEY、NEXTAUTH_SECRET、INTERNAL_INGEST_TOKEN、FLOWER_PASSWORD 等）通过本地 `backend/.env` + VPS `/root/believeboyDashboard/backend/.env` 各自维护，**不入库**。

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
python scripts/seed_admin_user.py --name=yawei --email=yawei@believeboy.com --password="$ADMIN_SEED_PASSWORD"
```

Force reset password:

```bash
cd backend
python scripts/seed_admin_user.py --email=yawei@believeboy.com --password="$ADMIN_SEED_PASSWORD" --reset-password
```

## Init User Accounts + Seed Admin (Recommended)

```bash
cd backend
python scripts/init_user_accounts.py
```

Force reset password while initializing:

```bash
cd backend
python scripts/init_user_accounts.py --email=yawei@believeboy.com --password="$ADMIN_SEED_PASSWORD" --reset-password
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

## 多 Worker 就绪说明

月报任务状态已迁移到 `Job` / `JobRun` 数据库行，`POST /api/v1/monthly-reports` 只创建 `Job` 并交给 Celery reports 队列，`GET /api/v1/monthly-reports/tasks/{task_id}` 从数据库读取 `Job.status`、最新 `JobRun.log_excerpt` 和 `monthly_reports.status`。因此 API 可以按 `uvicorn --workers N` 横向扩容，worker A 接收创建请求、worker B 响应状态查询会看到同一份 DB 事实源。

**建议发布流程**：先在 staging 将 API 扩到 `--workers 4`，再跑 `k6 saturation_50vu` 5 分钟，确认 p99 < 5s 且任务状态不丢、不串。Celery worker 进程的并发度仍由 systemd 单元的 `--concurrency=2` 控制（2026-07-29 由 4 降到 2，因 1.9 GiB VPS swap 已开始用，4 worker 子进程内存吃紧）；不要在同一台机器上用 `celery multi` 启多份 worker，除非已确认 broker 任务幂等与数据库锁策略。
