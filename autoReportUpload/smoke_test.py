"""One-shot smoke test: hit /heartbeat for each project and report status.

Run after deploy to confirm the autoReportUpload daemon can reach the
backend with the configured X-Internal-Token.

Usage:
    cd autoReportUpload && python smoke_test.py
"""
from __future__ import annotations

import sys
import time
from datetime import datetime

from api_client import APIClient, IngestError
from config import API_BASE_URL, INTERNAL_INGEST_TOKEN, PROJECTS


def main() -> int:
    client = APIClient(
        base_url=API_BASE_URL,
        token=INTERNAL_INGEST_TOKEN,
        timeout_seconds=15,
        max_retries=1,
    )
    now_ts = datetime.now().strftime("%Y%m%d%H%M%S")
    print(f"API_BASE_URL = {API_BASE_URL}")
    print(f"Projects ({len(PROJECTS)}): {', '.join(PROJECTS[:3])}...")
    print()

    successes = 0
    failures: list[tuple[str, str]] = []
    for project_name in PROJECTS:
        try:
            resp = client.heartbeat(
                instance_id=f"smoke-test-{now_ts}",
                last_run_ts=now_ts,
                last_status="ok",
                detail=f"smoke test for {project_name}",
            )
            if resp.get("accepted"):
                print(f"  ✓ {project_name}: heartbeat_id={resp.get('last_heartbeat_id')}")
                successes += 1
            else:
                failures.append((project_name, "no accepted=true"))
        except IngestError as exc:
            print(f"  ✗ {project_name}: {exc}")
            failures.append((project_name, str(exc)))
        time.sleep(0.2)

    print()
    print(f"Summary: {successes}/{len(PROJECTS)} projects reachable")
    if failures:
        print("Failures:")
        for name, err in failures:
            print(f"  - {name}: {err[:200]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())