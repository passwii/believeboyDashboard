.PHONY: help openapi-export openapi-check api test lint

# ---------------------------------------------------------------------------
# DTO single-source-of-truth (BEL-22-3 / BEL-29)
# ---------------------------------------------------------------------------
# `make openapi-export` dumps the FastAPI app's OpenAPI JSON to
# frontend/types/api-generated/openapi.json. That file is git-tracked so the
# frontend pipeline (`pnpm gen:api-types`) can run without a live backend.
#
# `make openapi-check` re-runs the export in-memory and fails if the committed
# file drifted from the current Pydantic schemas. This is the CI-friendly
# variant — it does not touch the file on disk.
# ---------------------------------------------------------------------------

OPENAPI_OUT := ../frontend/types/api-generated/openapi.json

# If a backend virtualenv exists in the standard locations, prefer it. This is
# only used by the export target — real local dev still uses run_api.sh.
VENV ?= $(if $(wildcard .venv/bin/python),.venv/bin/python,$(if $(wildcard ../.venv/bin/python),../.venv/bin/python,python))

help:
	@echo "Available targets:"
	@echo "  openapi-export  - Dump FastAPI OpenAPI JSON to $(OPENAPI_OUT)"
	@echo "  openapi-check   - Verify $(OPENAPI_OUT) matches current schema (CI gate)"
	@echo "  api             - Run the FastAPI dev server (uvicorn --reload)"
	@echo "  test            - Run pytest"
	@echo "  lint            - Placeholder (add ruff/flake8 here if you adopt one)"

openapi-export:
	@mkdir -p "$(dir $(OPENAPI_OUT))"
	@$(VENV) -m scripts.openapi_export --out "$(OPENAPI_OUT)"

openapi-check:
	@$(VENV) -m scripts.openapi_export --check --out "$(OPENAPI_OUT)"

api:
	./run_api.sh

test:
	python -m pytest

lint:
	@echo "No linter configured. Add ruff/flake8/mypy here as the project grows."
