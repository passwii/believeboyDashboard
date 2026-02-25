# Backend (FastAPI)

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Run API

```bash
./run_api.sh
```

## Run Worker

```bash
./run_worker.sh
```

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

## Auth

- All `/api/v1/*` except `/api/v1/health` require `X-API-Key`.

## Systemd (VPS)

```bash
cd backend
./scripts/systemd-install.sh
```
