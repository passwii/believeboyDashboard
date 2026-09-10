"""导出 Insight canonical contract：Pydantic JSON Schema + role manifest + fixtures 校验。

- 聚合 request/response/detail/error/event union JSON Schema 与 role manifest，
  固定排序、固定 `schema_version`；输出确定性字节（无时间戳）。
- `--out <dir>`：写入 `insight-contract.json`（默认 `frontend/types/api-generated`）。
- `--check`：工作树中的 generated artifact 无漂移则通过；Pydantic 改动未重跑则失败。
- `--fixtures <dir>`：同步 backend canonical fixtures 到前端目录（默认
  `frontend/types/api-generated/insight-fixtures`）；`--check` 同样校验一致。

用法：
    python scripts/export_insight_contract.py
    python scripts/export_insight_contract.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.schemas.insight import (
    ERROR_HTTP_STATUS,
    RETRYABLE_ERROR_CODES,
    InsightError,
    InsightErrorResponse,
    InsightRunActionResponse,
    InsightRunDetail,
    InsightRunRequest,
    InsightRunResponse,
)
from app.services.insight import limits as L
from app.services.insight.cursor import format_event_id
from app.services.insight.events import (
    ContentDeltaEvent,
    ContentSnapshotEvent,
    DoneEvent,
    ErrorEvent,
    InsightEventAdapter,
    PingEvent,
    SnapshotEvent,
    StatusEvent,
)
from app.services.insight.roles import role_manifest
from app.services.insight.slot_types import (
    ProjectContextSlot,
    ReportContextSlot,
    ReportDataSlot,
    SkuContextSlot,
)
from pydantic import TypeAdapter

SCHEMA_VERSION = 1

CONTRACT_FILENAME = "insight-contract.json"
FIXTURE_DIRNAME = "insight-fixtures"
FIXTURE_NAMES = ("normal-run", "failed-run", "cancelled-run", "retry-attempt", "resume-gap")


def build_contract() -> dict:
    """聚合合同：各模型的 JSON Schema + role manifest + 错误码表 + limits + cursor 语义。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "schemas": {
            "InsightRunRequest": TypeAdapter(InsightRunRequest).json_schema(),
            "InsightRunResponse": TypeAdapter(InsightRunResponse).json_schema(),
            "InsightRunDetail": TypeAdapter(InsightRunDetail).json_schema(),
            "InsightRunActionResponse": TypeAdapter(InsightRunActionResponse).json_schema(),
            "InsightError": TypeAdapter(InsightError).json_schema(),
            "InsightErrorResponse": TypeAdapter(InsightErrorResponse).json_schema(),
            "InsightEvent": InsightEventAdapter.json_schema(),
            "SnapshotEvent": TypeAdapter(SnapshotEvent).json_schema(),
            "StatusEvent": TypeAdapter(StatusEvent).json_schema(),
            "ContentDeltaEvent": TypeAdapter(ContentDeltaEvent).json_schema(),
            "ContentSnapshotEvent": TypeAdapter(ContentSnapshotEvent).json_schema(),
            "DoneEvent": TypeAdapter(DoneEvent).json_schema(),
            "ErrorEvent": TypeAdapter(ErrorEvent).json_schema(),
            "PingEvent": TypeAdapter(PingEvent).json_schema(),
            "ReportContextSlot": TypeAdapter(ReportContextSlot).json_schema(),
            "ReportDataSlot": TypeAdapter(ReportDataSlot).json_schema(),
            "ProjectContextSlot": TypeAdapter(ProjectContextSlot).json_schema(),
            "SkuContextSlot": TypeAdapter(SkuContextSlot).json_schema(),
        },
        "roles": role_manifest(),
        "errors": [
            {
                "code": code.value,
                "http_status": ERROR_HTTP_STATUS[code],
                "retryable": code in RETRYABLE_ERROR_CODES,
            }
            for code in sorted(ERROR_HTTP_STATUS, key=lambda c: c.value)
        ],
        "limits": {
            "request_body_max_bytes": L.REQUEST_BODY_MAX_BYTES,
            "slot_canonical_max_bytes": L.SLOT_CANONICAL_MAX_BYTES,
            "slots_total_max_bytes": L.SLOTS_TOTAL_MAX_BYTES,
            "string_max_chars": L.STRING_MAX_CHARS,
            "object_max_keys": L.OBJECT_MAX_KEYS,
            "object_key_max_chars": L.OBJECT_KEY_MAX_CHARS,
            "array_max_items": L.ARRAY_MAX_ITEMS,
            "json_max_depth": L.JSON_MAX_DEPTH,
            "status_detail_max_chars": L.STATUS_DETAIL_MAX_CHARS,
        },
        "cursor": {
            "format": "{run_id}:{attempt}:{seq}",
            "example": format_event_id("00000000-0000-4000-8000-000000000000", 1, 1),
            "resume_header": "Last-Event-ID",
        },
    }


def dump_canonical(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def load_fixture(name: str) -> bytes:
    path = ROOT / "tests" / "fixtures" / "insight" / f"{name}.json"
    return (json.dumps(json.loads(path.read_text(encoding="utf-8")), ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 Insight canonical contract")
    parser.add_argument("--out", default=str(ROOT.parent / "frontend" / "types" / "api-generated"))
    parser.add_argument("--fixtures", default=None)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    fixture_dir = Path(args.fixtures) if args.fixtures else out_dir / FIXTURE_DIRNAME

    contract_bytes = dump_canonical(build_contract())
    fixture_bytes = {name: load_fixture(name) for name in FIXTURE_NAMES}

    targets = {out_dir / CONTRACT_FILENAME: contract_bytes}
    targets.update({fixture_dir / f"{name}.json": payload for name, payload in fixture_bytes.items()})

    if args.check:
        drifted = [str(p) for p, want in targets.items() if not p.exists() or p.read_bytes() != want]
        if drifted:
            print("contract drift detected (re-run export_insight_contract.py):")
            for p in drifted:
                print(f"  - {p}")
            return 1
        print(f"contract in sync: {len(targets)} artifact(s)")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    fixture_dir.mkdir(parents=True, exist_ok=True)
    for path, payload in targets.items():
        path.write_bytes(payload)
    print(f"wrote {len(targets)} artifact(s) to {out_dir} (+ {fixture_dir})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
