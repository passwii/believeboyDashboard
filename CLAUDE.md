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

### One-off Backend Scripts
- `python scripts/seed_admin_user.py` — create admin user (use `--reset-password` to rotate)
- `python scripts/init_and_import_projects.py --file=/path/to.csv` — init projects table + import CSV
- `python scripts/init_user_accounts.py` — init user accounts + seed admin in one step
- `python scripts/import_blf_basic_info.py --file=/path/to/BLF_Basic_Info.csv` — import product data
- `alembic revision --autogenerate -m "desc"` — create migration; `alembic upgrade head` to apply

## Architecture

### Frontend → Backend Communication
The frontend **never connects to PostgreSQL directly**. All backend calls go through a Next.js API route proxy at `frontend/app/api/backend/[...path]/route.ts`, which forwards to `BACKEND_API_BASE_URL` (default `http://127.0.0.1:8000`) with `X-API-Key`, `X-User-Id`, `X-User-Name`, `X-Operator`, and `X-Is-Admin` headers. The backend validates the `X-API-Key` header via `app/core/security.py`.

### Backend API
- Entry: `backend/app/main.py`
- Routes: `backend/app/api/v1/router.py` (aggregates all endpoint routers)
- Endpoint modules: `backend/app/api/v1/endpoints/` — key groups:
  - `auth`, `users`, `projects`, `product_costs`, `exchange_rates`
  - `daily_reports`, `monthly_reports`, `product_analysis`, `product_analysis_reports`
  - `daily_analysis`, `ad_analysis`, `ad_upload`, `inventory_replenishment`
  - `pricing_calculation`, `store_accounting`, `shipment_schedules`, `store_sku_pricing_snapshots`
  - `category_research`, `report_upload`
  - `ai_chat`, `ai_file_upload`, `ai_insight`, `jobs`, `uploads`
  - `system_management`, `presence`, `health`
  - `return_analysis`, `project_goals`, `rpa_reports`
- Services: `backend/app/services/` (one service file per resource)
- Models: `backend/app/models/` (SQLAlchemy ORM models)
- Schemas: `backend/app/schemas/` (Pydantic request/response models)
- DB session: `backend/app/db/session.py`

### Frontend Structure
- `frontend/app/dashboard/` — page components (Next.js App Router):
  - `ai-panel/` — AI chat
  - `ai-insights/` — AI-powered data insights and analytics
  - `operations/` — site/store navigation, collaboration
  - `data-reporting/` — daily-report, monthly-report, product-analysis, pricing-calculation, store-accounting, new-product
  - `data-analysis/` — financial-data, weekly-product-analysis, daily-analysis, ad-analysis, inventory-analysis, inventory-replenishment, return-analysis, project-goals
  - `data-management/` — sku-cost, exchange-rate, report-upload, ad-upload, shipment-management
  - `system-management/` — account-management, operator-management, project-info, commission-management, commission-overview, logs, auto-upload
  - `tools/` — research-analysis, rpa-reports
  - `changelog/`
- `frontend/components/dashboard/` — shared dashboard components
- `frontend/components/ui/` — shadcn/ui base components
- `frontend/components/notifications/` — notification/toast system
- `frontend/lib/` — utilities, auth helpers, backend proxy helpers
- `frontend/app/api/backend/[...path]/route.ts` — proxies all backend calls; authenticates via NextAuth session, forwards `X-API-Key`, `X-User-Id`, `X-User-Name`, `X-Operator`, `X-Is-Admin` headers

### Auth
- **Frontend**: NextAuth.js v4 (configured in `frontend/app/api/auth/[...nextauth]/route.ts`)
- **Backend**: `X-API-Key` header validated by `require_api_key` in `app/core/security.py`. All routes except `/api/v1/health` are protected. Per-request user context comes from `X-Operator` / `X-User-Id` headers (set by the frontend proxy).

### Background Jobs
Jobs run as one-off Python processes via `backend/app/tasks/scripts/`. Celery + Redis are configured but not required in the current mode.

### autoReportUpload
A standalone Python service (`autoReportUpload/`) that monitors configured directories for new report files, auto-recognizes and uploads them to the backend. It is **not** part of the FastAPI app — run independently:

```bash
cd autoReportUpload && source ../backend/.venv/bin/activate
python run.py                  # normal mode (periodic loop)
python run.py --dry-run        # recognize only, no DB writes or file moves
python run.py --once           # single scan, no loop
```

### AI Chat
Uses an external AI provider configured via `AI_CHAT_PROVIDER_*` env vars. Web search is available via `AI_CHAT_WEB_SEARCH_*` vars. Chat history is stored in `AIConversation` / `AIMessage` models. AI-powered data insights are available via the `ai_insight` endpoint.

## Environment Variables

**Frontend** (`frontend/.env.local`):
- `BACKEND_API_BASE_URL` — backend URL (e.g. `http://127.0.0.1:8000`)
- `BACKEND_API_KEY` — shared API key
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET`

**Backend** (`backend/.env`):
- `DATABASE_URL` — PostgreSQL connection string (required)
- `API_KEY` — must match `BACKEND_API_KEY` in frontend
- `UPLOAD_ROOT`, `RESULT_ROOT` — file storage paths; `MAX_UPLOAD_BYTES` limits upload size
- `AI_CHAT_PROVIDER_BASE_URL`, `AI_CHAT_PROVIDER_API_KEY`, `AI_CHAT_DEFAULT_MODEL`, `AI_CHAT_MODEL_BLOCKLIST`, `AI_CHAT_PREMIUM_MODELS`, `AI_CHAT_BASIC_MODELS`, `AI_CHAT_TIMEOUT_SECONDS` — AI provider config
- `AI_CHAT_WEB_SEARCH_BASE_URL`, `AI_CHAT_WEB_SEARCH_API_KEY` — web search config
- `REDIS_*` — Redis for presence features (optional)

## Database
PostgreSQL only — no SQLite fallback. All models are in `backend/app/models/`. Use Alembic for migrations.

## Additional Docs
- `backend/README.md` — detailed backend documentation
- `backend/REDIS_PLAN.md` — Redis integration plan (Celery/Redis are optional)
- `backend/docs/report-processing-sync-spec.md` — report processing sync specification

## Design Context

### Users
Operations teams managing cross-border e-commerce on Amazon. They live in the dashboard daily — monitoring KPIs, uploading reports, running AI-generated analysis. They are power users who need efficiency, clarity, and trust in the data. They are not casual consumers; the interface should respect their expertise and time.

### Brand Personality
**Professional, data-driven, calm confidence.** Like Linear or Stripe — tools that feel precise and in-control. Not playful, not corporate-stiff. The brand name "BelieveBoy" suggests human warmth beneath the professionalism.

Three-word personality: **Precise · Clear · Trusted**

### Aesthetic Direction
B2B SaaS dashboard with a light-mode-first design. Inspired by Linear's information density and clarity, Vercel's clean white surfaces, and Stripe's confident use of color for data semantics. Anti-references: busy enterprise dashboards with cluttered cards, or generic dark-only tech UIs.

- Light mode primary, dark mode fully supported
- Frosted glass surfaces (`.dashboard-surface`) for visual layering without clutter
- Data colors: green (positive), amber (warning), red (negative), neutral gray — semantic, not decorative
- Generous but purposeful whitespace; information density is okay on data tables

### Design Principles
1. **Data clarity first** — Every visual decision serves the numbers. Charts, colors, and spacing must make data easier to read, not prettier to look at.
2. **Calm surfaces, confident accents** — Light neutral backgrounds with a single strong blue primary. Color appears mostly on data (charts, status badges) and interactive elements.
3. **Motion with purpose** — Animations communicate state (streaming, loading, transitions). Never decorative. Respect `prefers-reduced-motion`.
4. **Consistent surface language** — Use `.dashboard-surface`, `.dashboard-panel`, `.dashboard-toolbar` consistently. Avoid ad-hoc card styling.
5. **Typography creates hierarchy** — Space Grotesk for display/numbers, Manrope for UI text. Large display numbers for KPIs, small kicker labels for metadata.

## Key Conventions
- Backend uses Pydantic v2 (`pydantic-settings` for env config)
- Frontend uses React 18 with TanStack Table v8 and Recharts
- Next.js App Router pages are split: `page.tsx` (server component) + `*-client.tsx` (client component) when interactivity is needed
- All backend API endpoints follow `/api/v1/{resource}/` naming
