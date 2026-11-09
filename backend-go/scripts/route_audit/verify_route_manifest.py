from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "docs/superpowers/plans/2026-11-07-fastapi-to-go-migration/stage7-route-manifest.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
counts = manifest["counts"]
validation = manifest["validation"]

require(counts["fastapi"]["openapi_operations"] == 623, "OpenAPI operation count changed")
require(counts["go"]["source_only_unwired_operations"] == 0, "Go source-only routes remain unwired")
require(counts["comparison"]["exact_owned_operations"] == 623, "OpenAPI route parity is incomplete")
require(counts["comparison"]["missing_operations"] == 0, "OpenAPI routes are missing")
require(counts["comparison"]["method_mismatch_operations"] == 0, "HTTP method mismatches remain")
require(counts["comparison"]["coverage_percent"] == 100.0, "Coverage is not 100%")
require(counts["agent"]["exact_owned"] == 128, "Agent route parity is incomplete")
require(counts["agent"]["missing"] == 0, "Agent routes are missing")
require(counts["p0"]["missing_operations"] == 0, "P0 missing routes remain")

require(len(manifest["routes"]) == validation["expected_route_array_rows"], "Route array row count mismatch")
require(len(manifest["fastapi_routes"]) == validation["expected_fastapi_rows"], "FastAPI row count mismatch")
require(len(manifest["agent_routes"]) == validation["expected_agent_rows"], "Agent row count mismatch")
require(len(manifest["go_active_routes"]) == validation["expected_go_active_rows"], "Go active row count mismatch")
require(len(manifest["go_source_only_routes"]) == validation["expected_go_source_only_rows"], "Go source-only row count mismatch")
require(len(manifest["missing"]) == validation["expected_missing_rows"], "Missing row count mismatch")
require(len(manifest["method_mismatch"]) == validation["expected_method_mismatch_rows"], "Method mismatch row count mismatch")
require(len(manifest["owned_pairs"]) == validation["expected_owned_rows"], "Owned pair row count mismatch")
require(len(manifest["go_only"]) == validation["expected_go_only_rows"], "Go-only row count mismatch")
require(len(manifest["contract_risks"]) == validation["expected_contract_risk_rows"], "Contract risk row count mismatch")

print(
    "route manifest verified: "
    f"{counts['comparison']['exact_owned_operations']}/"
    f"{counts['fastapi']['openapi_operations']} OpenAPI operations, "
    f"{counts['comparison']['go_only_operations']} Go-only, "
    f"{counts['p0']['contract_items']} P0 path-semantics items"
)
