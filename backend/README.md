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

## Systemd (VPS)

```bash
cd backend
./scripts/systemd-install.sh
```
