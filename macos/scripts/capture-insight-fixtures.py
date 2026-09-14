#!/usr/bin/env python3
# pyright: reportMissingImports=false
#
# ↑ `app.*` 只在**运行时**可导入：脚本把 `backend/` 插进 `sys.path` 后才 import（见
# `main()`）。静态分析器按仓库根解析不到 `backend/app` 这个包名，这不是缺陷 —— 故在这里
# 关掉这一条，而不是把 import 改成难以阅读的 `importlib.import_module` 字符串。
"""抓取「AI 洞察三页」6 条端点的**真实后端响应**快照（BLF-1062，macOS Stage 5.3）。

用途：把「同源同结构」（issue §口径 1）变成可执行断言。`InsightDecodingTests` /
`InsightClientTests` / `InsightStreamTests` / `InsightMarkdownTests` 拿这里落盘的响应
去断言「字段名 / 状态机 / 事件类型序列 / 数值口径」，后端字段改名或帧形状漂移会在测试里报红。

口径（与 `Fixtures/Insight/README.md` 一致，改了这里就要同步改那里）：

* 只发 **GET**（纯读，无写请求）；走 FastAPI `TestClient` 的真实路由，不直接调 service 函数。
* 鉴权：`X-API-Key`（主 key，取 `backend/.env` 的 `API_KEY`）+ `X-Is-Admin: true`
  + `X-Operator: admin`，与 S5.1 / S5.2 两批同一组账号上下文。
* 固定参数：`project_id=1`、`country=US`、`limit=20` —— 与 S5.1/S5.2 同一组，便于三批互相对照。

数据来源分两段（**这是本批与 S5.1 / S5.2 最大的差异，必须写清楚**）：

| 段 | 端点 | 库 | 理由 |
| --- | --- | --- | --- |
| A | `GET /ai-insights`、`/ai-insights/{id}`、`/ai-insights/schedules`、`/ai-insights/{id}/stream` | 生产快照库 `BLF`（`backend/.env` 的 `DATABASE_URL`） | 旧洞察链路，生产快照里**有** 47 条真实洞察 —— 与 S5.1/S5.2 同源 |
| B | `GET /insight/runs/{id}`、`/insight/runs/{id}/stream` | 隔离库 `BLF_test`（`TEST_DATABASE_URL` 约定） | canonical run 在生产快照里**一行都没有**（实测 `select count(*) from insight_runs` = 0）—— 因此只能在本隔离库上**造一条真实 run 行**，再由真实路由序列化 / 编码 |

段 B 的「造行」只做两件事：插一条 `insight_runs` 行（completed / failed 各一条）、抓完即删。
**不写 `BLF`**（AGENTS.md 的硬约束），也不发任何写端点 —— 抓完把隔离库恢复原样。
响应本身 100% 由后端真实代码产出（`to_detail` 序列化 + `_sse_frame` 帧编码 +
`insight_runs.py` 的 `Last-Event-ID` 校验）。段 B 的 Redis 流是**空的**，正好走
`subscriber.py` 里那条「run 已终态 + 流已过期 → 从 DB 快照合成终态帧」的分支，把
「断线后重连续传仍能拿到终态」这条语义钉成真实帧。

用法：

    python3 macos/scripts/capture-insight-fixtures.py                    # 写入默认目录
    python3 macos/scripts/capture-insight-fixtures.py --out <dir>        # 写别处（复核漂移用）

重抓后必须同时更新 manifest 的 `sha256` / `bytes` / `captured_at`，并在 PR 里写明新的哈希
—— `InsightDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_OUT = REPO_ROOT / "macos" / "Tests" / "BelieveBoyTests" / "Fixtures" / "Insight"

#: 段 A（旧洞察，生产快照库 BLF）的项目 —— 与 S5.1 / S5.2 同一组，便于三批互相对照。
PROJECT_ID = 1
#: 段 B（canonical run，隔离库 BLF_test）的项目 —— 该库里没有 id=1 的项目，用 427（「测试项目」）。
#: `ensure_project_access` 会先查 `projects`，项目不存在直接 404「项目不存在」。
RUN_PROJECT_ID = 427
COUNTRY = "US"
PAGE_LIMIT = 20

#: 段 B 造的两条 run 的固定 run_id（固定值 = 夹具可复现，`sha256` 才有意义）。
SEEDED_COMPLETED_RUN_ID = "b1f00000-0000-4000-8000-0000000000c1"
SEEDED_FAILED_RUN_ID = "b1f00000-0000-4000-8000-0000000000f1"

SEEDED_MARKDOWN = (
    "# 广告分析结论\n\n"
    "近 7 天广告花费上升、ACOS 恶化。\n\n"
    "## 关键指标\n\n"
    "| 指标 | 本期 | 上期 |\n| --- | --- | --- |\n"
    "| 花费 | 12345.67 | 11000.00 |\n| ACOS | 28.41% | 24.90% |\n\n"
    "```chart\n"
    '{"type":"line","data":{"labels":["09-01","09-02"],"datasets":[{"label":"花费","data":[100,200]}]}}\n'
    "```\n\n"
    "## 建议\n\n1. 收紧低效活动的预算。\n2. 观察 3 天后再评估。\n"
)


def pretty(payload: object) -> bytes:
    """落盘形态：2 空格缩进 + 键排序 —— 夹具要能被人工 `diff` / `jq` 复查。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return (text + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def testing_database_url(production_url: str) -> str:
    """生产库 URL → 隔离库 URL（只换库名，其余连接参数不动）。"""
    head, _, _ = production_url.rpartition("/")
    return f"{head}/BLF_test"


def seed_runs(session) -> None:
    """在隔离库里落两条**终态** run（一条 completed、一条 failed），复现真实行长。"""
    import json as _json

    from app.models.insight_run import InsightRun
    from sqlalchemy import delete

    session.execute(
        delete(InsightRun).where(
            InsightRun.run_id.in_([SEEDED_COMPLETED_RUN_ID, SEEDED_FAILED_RUN_ID])
        )
    )
    session.commit()

    content_sha = hashlib.sha256(SEEDED_MARKDOWN.encode("utf-8")).hexdigest()
    completed = InsightRun(
        run_id=SEEDED_COMPLETED_RUN_ID,
        attempt=1,
        capability="insight",
        use_case="ad_analysis.v1",
        project_id=RUN_PROJECT_ID,
        country=COUNTRY,
        role_id="ad_analysis",
        role_version=1,
        endpoint_id="ad_analysis",
        model_id="anthropic:claude-sonnet-4",
        status="completed",
        stage="finalizing",
        progress_percent=100,
        idempotency_key="blf-1062-fixture-completed",
        request_fingerprint="0" * 64,
        slots_json=_json.dumps({"project_id": RUN_PROJECT_ID, "country": COUNTRY}),
        status_timeline_json=_json.dumps([]),
        usage_json=_json.dumps(
            {"input_tokens": 1200, "output_tokens": 800, "total_tokens": 2000}
        ),
        outputs_json=_json.dumps(
            {
                "main": {
                    "format": "markdown",
                    "content": SEEDED_MARKDOWN,
                    "content_sha256": content_sha,
                }
            }
        ),
        content_markdown=SEEDED_MARKDOWN,
        duration_ms=8421,
    )
    failed = InsightRun(
        run_id=SEEDED_FAILED_RUN_ID,
        attempt=1,
        capability="insight",
        use_case="inventory_health.v1",
        project_id=RUN_PROJECT_ID,
        country=COUNTRY,
        role_id="inventory_health",
        role_version=1,
        endpoint_id="inventory_health",
        model_id="anthropic:claude-sonnet-4",
        status="failed",
        stage="generating",
        progress_percent=40,
        idempotency_key="blf-1062-fixture-failed",
        request_fingerprint="1" * 64,
        slots_json=_json.dumps({"project_id": RUN_PROJECT_ID, "country": COUNTRY}),
        status_timeline_json=_json.dumps([]),
        error_json=_json.dumps(
            {
                "code": "UPSTREAM_TIMEOUT",
                "message": "provider timed out after 60s",
                "retryable": True,
                "partial_available": False,
            }
        ),
        duration_ms=60000,
    )
    session.add_all([completed, failed])
    session.commit()


def clear_seeded_runs(session) -> None:
    from app.models.insight_run import InsightRun
    from sqlalchemy import delete

    session.execute(
        delete(InsightRun).where(
            InsightRun.run_id.in_([SEEDED_COMPLETED_RUN_ID, SEEDED_FAILED_RUN_ID])
        )
    )
    session.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出目录")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(BACKEND_DIR))
    from app.core.config import get_settings  # noqa: E402

    production_url = get_settings().database_url
    test_url = testing_database_url(production_url)
    headers_base = {
        "X-Is-Admin": "true",
        "X-Operator": "admin",
    }

    files: list[dict[str, object]] = []
    streams: list[dict[str, object]] = []

    def record_json(name: str, payload: object, endpoint: str, note: str) -> None:
        body = pretty(payload)
        (args.out / name).write_bytes(body)
        files.append(
            {
                "endpoint": endpoint,
                "file": name,
                "bytes": len(body),
                "sha256": sha256(body),
                "note": note,
            }
        )
        print(f"{name:38s} {len(body):8d} B  {sha256(body)[:16]}")

    def record_text(name: str, text: str, endpoint: str, note: str) -> None:
        body = text.encode("utf-8")
        (args.out / name).write_bytes(body)
        streams.append(
            {
                "endpoint": endpoint,
                "file": name,
                "bytes": len(body),
                "sha256": sha256(body),
                "note": note,
            }
        )
        print(f"{name:38s} {len(body):8d} B  {sha256(body)[:16]}")

    # ---------------------------------------------------------------- 段 A：生产快照库 BLF
    os.environ["DATABASE_URL"] = production_url
    for module in [m for m in list(sys.modules) if m.startswith("app.")]:
        del sys.modules[module]

    from app.core.config import get_settings as prod_settings  # noqa: E402
    from app.main import app as prod_app  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402

    prod = prod_settings()
    assert prod.database_url.endswith("/BLF"), prod.database_url
    headers = {"X-API-Key": prod.api_key, **headers_base}
    client = TestClient(prod_app)

    list_response = client.get(
        "/api/v1/ai-insights",
        params={
            "project_id": PROJECT_ID,
            "country": COUNTRY,
            "limit": PAGE_LIMIT,
            "offset": 0,
        },
        headers=headers,
    )
    list_response.raise_for_status()
    list_payload = list_response.json()
    record_json(
        "ai-insights-list.json",
        list_payload,
        "GET /api/v1/ai-insights",
        f"project_id={PROJECT_ID} country={COUNTRY} limit={PAGE_LIMIT} offset=0；total="
        f"{list_payload.get('total')} items={len(list_payload.get('items', []))}",
    )

    ad_response = client.get(
        "/api/v1/ai-insights",
        params={"insight_type": "ad_analysis", "limit": PAGE_LIMIT, "offset": 0},
        headers=headers,
    )
    ad_response.raise_for_status()
    ad_payload = ad_response.json()
    record_json(
        "ai-insights-ad-analysis-list.json",
        ad_payload,
        "GET /api/v1/ai-insights?insight_type=ad_analysis",
        "「AI 广告分析」页历史列表的固定参数（同一端点的第二种固定参数组）；"
        f"total={ad_payload.get('total')}",
    )

    insight_id = list_payload["items"][0]["id"]
    detail_response = client.get(f"/api/v1/ai-insights/{insight_id}", headers=headers)
    detail_response.raise_for_status()
    detail_payload = detail_response.json()
    record_json(
        "ai-insights-detail.json",
        detail_payload,
        f"GET /api/v1/ai-insights/{insight_id}",
        f"列表首条（id={insight_id}）明细；content {len(detail_payload.get('content') or '')} 字符",
    )

    schedules_response = client.get("/api/v1/ai-insights/schedules", headers=headers)
    schedules_response.raise_for_status()
    schedules_payload = schedules_response.json()
    record_json(
        "ai-insights-schedules.json",
        schedules_payload,
        "GET /api/v1/ai-insights/schedules",
        "无筛选；生产快照库当前 0 条定时任务（空态夹具）",
    )

    # 旧链路的 SSE：已终态的洞察立即回一帧 status 然后关闭（真实帧，非打桩）。
    legacy_stream_response = client.get(
        f"/api/v1/ai-insights/{insight_id}/stream",
        headers={**headers, "Accept": "text/event-stream"},
    )
    legacy_stream_response.raise_for_status()
    record_text(
        "ai-insights-stream-terminal.txt",
        legacy_stream_response.text,
        f"GET /api/v1/ai-insights/{insight_id}/stream",
        "旧链路 SSE 原文（已终态 → 立即一帧 status 后关闭）；该端点不发 id: 也不认 Last-Event-ID",
    )

    client.close()

    # ------------------------------------------- 段 B：隔离库 BLF_test + 真实路由（造行→抓→删）
    os.environ["DATABASE_URL"] = test_url
    os.environ["DATABASE_READ_URL"] = test_url
    for module in [m for m in list(sys.modules) if m.startswith("app.")]:
        del sys.modules[module]

    from app.core.config import get_settings as test_settings  # noqa: E402
    from app.db.session import SessionLocal  # noqa: E402
    from app.main import app as test_app  # noqa: E402

    test_config = test_settings()
    assert test_config.database_url.endswith("/BLF_test"), test_config.database_url
    session = SessionLocal()
    seed_runs(session)
    session.close()

    try:
        test_client = TestClient(test_app)
        test_headers = {"X-API-Key": test_config.api_key, **headers_base}

        for label, run_id, note in [
            ("completed", SEEDED_COMPLETED_RUN_ID, "终态 completed（含 outputs/usage/artifact_id）"),
            ("failed", SEEDED_FAILED_RUN_ID, "终态 failed（含 typed error）"),
        ]:
            run_detail = test_client.get(f"/api/v1/insight/runs/{run_id}", headers=test_headers)
            run_detail.raise_for_status()
            record_json(
                f"insight-run-detail-{label}.json",
                run_detail.json(),
                f"GET /api/v1/insight/runs/{{run_id}}（{label}）",
                note,
            )

            stream = test_client.get(
                f"/api/v1/insight/runs/{run_id}/stream",
                headers={**test_headers, "Accept": "text/event-stream"},
            )
            stream.raise_for_status()
            record_text(
                f"insight-run-stream-{label}.txt",
                stream.text,
                f"GET /api/v1/insight/runs/{{run_id}}/stream（{label}）",
                "真实 SSE 帧序列（含 id: 游标）；Redis 无历史 → 走「从 DB 快照合成终态帧」分支",
            )

            first_id = None
            for line in stream.text.splitlines():
                if line.startswith("id: "):
                    first_id = line[4:].strip()
                    break
            if first_id:
                resumed = test_client.get(
                    f"/api/v1/insight/runs/{run_id}/stream",
                    headers={
                        **test_headers,
                        "Accept": "text/event-stream",
                        "Last-Event-ID": first_id,
                    },
                )
                resumed.raise_for_status()
                record_text(
                    f"insight-run-stream-{label}-resume.txt",
                    resumed.text,
                    f"GET /api/v1/insight/runs/{{run_id}}/stream（{label} · Last-Event-ID 续传）",
                    f"带 Last-Event-ID: {first_id} 的续传响应（断言游标语义：只回终态帧、不回已见帧）",
                )

        # 非法游标：真实路由的 400（typed RESUME_CURSOR_INVALID）—— 客户端要能识别并回退。
        bad = test_client.get(
            f"/api/v1/insight/runs/{SEEDED_COMPLETED_RUN_ID}/stream",
            headers={
                **test_headers,
                "Accept": "text/event-stream",
                "Last-Event-ID": "not-a-cursor",
            },
        )
        record_json(
            "insight-run-stream-invalid-cursor.json",
            {"status": bad.status_code, "body": bad.json()},
            "GET /api/v1/insight/runs/{run_id}/stream（Last-Event-ID 非法）",
            "真实错误响应（400 typed）；客户端据此回退到 detail 端点",
        )
        test_client.close()
    finally:
        session = SessionLocal()
        clear_seeded_runs(session)
        session.close()

    manifest = {
        "captured_at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "captured_by": "BLF-1062（macOS Stage 5.3 AI 洞察三页）",
        "auth": "X-API-Key（主 key）+ X-Is-Admin: true + X-Operator: admin",
        "capture_script": "macos/scripts/capture-insight-fixtures.py（只读 GET，无写请求）",
        "params": {
            "project_id": PROJECT_ID,
            "country": COUNTRY,
            "limit": PAGE_LIMIT,
        },
        "source_a": {
            "database": "生产快照库 BLF（backend/.env 的 DATABASE_URL）",
            "endpoints": [
                "GET /api/v1/ai-insights",
                "GET /api/v1/ai-insights/{insight_id}",
                "GET /api/v1/ai-insights/schedules",
                "GET /api/v1/ai-insights/{insight_id}/stream",
            ],
            "note": "与 S5.1/S5.2 同源（生产快照库），固定 project_id=1 / country=US。",
        },
        "source_b": {
            "database": "隔离库 BLF_test（生产 URL 换库名）",
            "endpoints": [
                "GET /api/v1/insight/runs/{run_id}",
                "GET /api/v1/insight/runs/{run_id}/stream",
            ],
            "note": (
                "canonical run 在生产快照库里 0 行（实测 select count(*) from insight_runs = 0），"
                "故在隔离库插入两条真实终态 run 行（固定 run_id），抓完即删；响应由真实路由产出。"
            ),
            "seeded_run_ids": {
                "completed": SEEDED_COMPLETED_RUN_ID,
                "failed": SEEDED_FAILED_RUN_ID,
            },
            "project_id": RUN_PROJECT_ID,
            "country": COUNTRY,
        },
        "files": files,
        "streams": streams,
    }
    (args.out / "manifest.json").write_bytes(pretty(manifest))
    print(f"manifest → {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
