# Backend (FastAPI)

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

`backend/.env` 用于后端自己的运行配置，其中 `DATABASE_URL`、`PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 都只应保留在后端，不应放到前端的 `.env.local`。`AI_CHAT_PROVIDER_BASE_URL`、`AI_CHAT_PROVIDER_API_KEY`、`AI_CHAT_DEFAULT_MODEL`、`AI_CHAT_MODEL_ALLOWLIST`、`AI_CHAT_TIMEOUT_SECONDS` 也统一放在后端。`DATABASE_URL` 现在是必填项，未配置时后端和 Alembic 会直接报错，不再回退到本地 SQLite。

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
