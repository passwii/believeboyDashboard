# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BelieveBoy Dashboard is a cross-border e-commerce operations management platform. It has a **Next.js 14 frontend** and a **FastAPI backend**, both in a single monorepo under `frontend/` and `backend/`.

## Running the Project

### Frontend
```bash
cd frontend && pnpm install && pnpm dev        # http://localhost:3000
pnpm build && pnpm start                      # production
pnpm lint                                     # linter
```

### Backend
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                          # fill in DATABASE_URL + API_KEY
./run_api.sh                                  # http://localhost:8000
alembic upgrade head                          # run migrations
pytest                                        # run tests (cd backend first)
pytest tests/path/to/test_file.py::test_name  # single test
```

### DB Migrations
```bash
cd backend
alembic revision --autogenerate -m "desc"     # create migration
alembic upgrade head                           # apply
```

## Architecture

### Frontend → Backend Communication
The frontend **never connects to PostgreSQL directly**. All backend calls go through a Next.js API route proxy at `frontend/app/api/backend/[...path]/route.ts`, which forwards to `BACKEND_API_BASE_URL` (default `http://127.0.0.1:8000`) with `X-API-Key`, `X-User-Id`, `X-User-Name`, `X-Operator`, and `X-Is-Admin` headers. The backend validates the `X-API-Key` header via `app/core/security.py`.

### Backend API
- Entry: `backend/app/main.py`
- Routes: `backend/app/api/v1/router.py` (aggregates all endpoint routers)
- Endpoint modules: `backend/app/api/v1/endpoints/`
- Services: `backend/app/services/` (business logic)
- Models: `backend/app/models/` (SQLAlchemy ORM models)
- Schemas: `backend/app/schemas/` (Pydantic request/response models)
- DB session: `backend/app/db/session.py`

### Frontend Structure
- `frontend/app/dashboard/` — page components (Next.js App Router)
- `frontend/components/dashboard/` — shared dashboard components
- `frontend/components/ui/` — shadcn/ui base components
- `frontend/components/notifications/` — notification/toast system
- `frontend/lib/` — utilities, auth, backend proxy helpers

### Auth
- **Frontend**: NextAuth.js v4 (configured in `frontend/app/api/auth/[...nextauth]/route.ts`)
- **Backend**: `X-API-Key` header validated by `require_api_key` in `app/core/security.py`. All routes except `/api/v1/health` are protected. Per-request user context comes from `X-Operator` / `X-User-Id` headers (set by the frontend proxy).

### Background Jobs
Jobs run as one-off Python processes via `backend/app/tasks/scripts/`. Celery + Redis are configured but not required in the current mode.

### AI Chat
Uses an external AI provider configured via `AI_CHAT_PROVIDER_*` env vars. Web search is available via `AI_CHAT_WEB_SEARCH_*` vars. Chat history is stored in `AIConversation` / `AIMessage` models.

## Environment Variables

**Frontend** (`frontend/.env.local`):
- `BACKEND_API_BASE_URL` — backend URL (e.g. `http://127.0.0.1:8000`)
- `BACKEND_API_KEY` — shared API key
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET`

**Backend** (`backend/.env`):
- `DATABASE_URL` — PostgreSQL connection string (required)
- `API_KEY` — must match `BACKEND_API_KEY` in frontend
- `AI_CHAT_PROVIDER_*`, `AI_CHAT_WEB_SEARCH_*` — AI provider config
- `REDIS_*` — Redis for presence features (optional)

## Database
PostgreSQL only — no SQLite fallback. All models are in `backend/app/models/`. Use Alembic for migrations.

## Key Conventions
- Backend uses Pydantic v2 (`pydantic-settings` for env config)
- Frontend uses React 18 with TanStack Table v8 and Recharts
- Next.js App Router pages are split: `page.tsx` (server component) + `*-client.tsx` (client component) when interactivity is needed
- All backend API endpoints follow `/api/v1/{resource}/` naming
