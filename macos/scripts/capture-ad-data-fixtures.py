#!/usr/bin/env python3
# pyright: reportMissingImports=false
#
# ↑ `app.*` 只在**运行时**可导入：脚本把 `backend/` 插进 `sys.path` 后才 import（见
# `main()`）。静态分析器按仓库根解析不到 `backend/app` 这个包名，这不是缺陷 —— 故在这里
# 关掉这一条，而不是把 import 改成难以阅读的 `importlib.import_module` 字符串。
"""抓取「广告数据」页 11 个端点的**真实后端响应**快照（BLF-1057，macOS Stage 5.2）。

用途：把「与 Web 同源同值」变成可执行断言。`AdDataDecodingTests` / `AdDataClientTests`
拿这里落盘的 JSON 去断言「每个列键都能取到值」，字段改名 / 类型漂移会在测试里报红，
不必等到人工对比 Web。

口径（与 `Fixtures/AdData/README.md` 一致，改了这里就要同步改那里）：

* 只发 GET（纯读，无写请求）；走 FastAPI `TestClient` 的真实路由，不直接调 service 函数。
* 鉴权：`X-API-Key`（主 key，取 `backend/.env` 的 `API_KEY`）+ `X-Is-Admin: true`。
* 固定参数：`project_id=1`、`country=US`、`period=custom` +
  **哨兵窗口** `start_date=2000-01-01`、`end_date=2100-12-31` —— 与 S5.1 广告分析页
  同一组固定参数，便于两批互相对照。

  ⚠️ 「不传日期」在 ad-data 上**不是**全量历史，而是 400（`period` 必填语义）——
  所以这里照 Web（`frontend/components/dashboard/ad-data/ad-data-explorer.tsx`）的哨兵窗口
  写法，而不是 S5.1 那种「不传日期参数」。

* 落盘 `limit=200`：页面口径是 `limit=10000`，但那 10 个端点合起来有 **22.5 MB**
  （实测，最大 `ad-promoted-products-raw` 单份 9.9 MB）—— 把 22 MB 真实响应塞进 git 历史
  的代价远大于收益，而**解析器要钉的东西与行数无关**（信封键名 / 逐类型列键 / `raw_row`
  中文列 / 值类型）。故夹具取 200 行切片，同时在 manifest 里记下 `limit=10000` 的**真实**
  行数与字节数（`full_rows` / `full_bytes`），「10 个类型都不到 10000 行、今天不截断」这条
  结论因此仍可从 manifest 复核。

用法：

    python3 macos/scripts/capture-ad-data-fixtures.py                    # 写入默认目录
    python3 macos/scripts/capture-ad-data-fixtures.py --out <dir>        # 写别处（复核漂移用）

重抓后必须同时更新 manifest 的 `sha256` / `bytes` / 计数与 `captured_at`，并在 PR 里写明
新的哈希 —— `AdDataDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_OUT = REPO_ROOT / "macos" / "Tests" / "BelieveBoyTests" / "Fixtures" / "AdData"

PROJECT_ID = 1
COUNTRY = "US"
SENTINEL_START = "2000-01-01"
SENTINEL_END = "2100-12-31"
FIXTURE_LIMIT = 200
PAGE_LIMIT = 10000
UPLOAD_FILES_LIMIT = 500

# 顺序与 `frontend/lib/ad-data.ts` 的 `AD_DATA_REPORT_TYPES` 一致。
ENDPOINTS: list[tuple[str, str]] = [
    ("campaigns", "ad_campaign_report"),
    ("budgets", "ad_budget_report"),
    ("targets", "ad_target_report"),
    ("placements", "ad_placement_report"),
    ("search-terms", "ad_search_term_report"),
    ("search-term-shares", "ad_search_term_share_report"),
    ("promoted-products", "ad_promoted_product_report"),
    ("time-trends", "ad_time_trend_report"),
    ("invalid-traffic", "ad_invalid_traffic_report"),
    ("purchased-products", "ad_purchased_product_report"),
]


def raw_query(limit: int) -> dict[str, str]:
    return {
        "period": "custom",
        "start_date": SENTINEL_START,
        "end_date": SENTINEL_END,
        "country": COUNTRY,
        "limit": str(limit),
    }


def pretty(payload: object) -> bytes:
    """落盘形态：2 空格缩进 + 键排序 —— 夹具要能被人工 `diff` / `jq` 复查。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return (text + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出目录")
    args = parser.parse_args()

    sys.path.insert(0, str(BACKEND_DIR))
    from app.core.config import get_settings  # noqa: E402
    from app.main import app  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402  （必须在 sys.path 之后）

    settings = get_settings()
    headers = {
        "X-API-Key": settings.api_key,
        "X-Is-Admin": "true",
        "X-Operator": "admin",
    }
    client = TestClient(app)
    args.out.mkdir(parents=True, exist_ok=True)

    files: list[dict[str, object]] = []
    for endpoint, report_type in ENDPOINTS:
        path = f"/api/v1/internal/ad-data/projects/{PROJECT_ID}/ad-{endpoint}-raw"
        slice_response = client.get(path, params=raw_query(FIXTURE_LIMIT), headers=headers)
        slice_response.raise_for_status()
        body = pretty(slice_response.json())
        file_name = f"ad-data-{endpoint}-raw.json"
        (args.out / file_name).write_bytes(body)

        full_response = client.get(path, params=raw_query(PAGE_LIMIT), headers=headers)
        full_response.raise_for_status()
        full_rows = len(full_response.json()["data"])

        files.append(
            {
                "endpoint": endpoint,
                "report_type": report_type,
                "file": file_name,
                "bytes": len(body),
                "sha256": sha256(body),
                "rows": len(slice_response.json()["data"]),
                "full_rows": full_rows,
                "full_bytes": len(full_response.content),
            }
        )
        print(f"{endpoint:22s} fixture={len(slice_response.json()['data']):4d} rows "
              f"full={full_rows:5d} rows / {len(full_response.content):9d} B")

    upload_path = f"/api/v1/internal/ad-data/projects/{PROJECT_ID}/ad-upload-files"
    upload_response = client.get(
        upload_path,
        params={"country": COUNTRY, "limit": str(UPLOAD_FILES_LIMIT)},
        headers=headers,
    )
    upload_response.raise_for_status()
    upload_body = pretty(upload_response.json())
    (args.out / "ad-upload-files.json").write_bytes(upload_body)
    upload_items = upload_response.json()
    report_types = sorted({item["report_type"] for item in upload_items})
    print(f"{'ad-upload-files':22s} items={len(upload_items):4d} types={len(report_types)}")

    manifest = {
        "captured_at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "captured_by": "BLF-1057（macOS Stage 5.2 广告数据页）",
        "backend": (
            "本地后端 + 生产快照库 BLF（backend/.env 的 DATABASE_URL），"
            "经 FastAPI TestClient 走真实 HTTP 路由"
        ),
        "auth": "X-API-Key（主 key）+ X-Is-Admin: true",
        "capture_script": "macos/scripts/capture-ad-data-fixtures.py（只读 GET，无写请求）",
        "params": {
            "project_id": PROJECT_ID,
            "country": COUNTRY,
            "period": "custom",
            "start_date": SENTINEL_START,
            "end_date": SENTINEL_END,
            "fixture_limit": FIXTURE_LIMIT,
            "page_limit": PAGE_LIMIT,
            "note": (
                "夹具落盘用 limit=200（体积纪律，见 README）；full_rows / full_bytes 是 "
                "limit=10000（页面口径）时的真实行数与响应字节数，只测量不落盘。"
            ),
        },
        "files": files,
        "upload_files": {
            "file": "ad-upload-files.json",
            "bytes": len(upload_body),
            "sha256": sha256(upload_body),
            "items": len(upload_items),
            "limit": UPLOAD_FILES_LIMIT,
            "country": COUNTRY,
            "report_types": report_types,
        },
    }
    (args.out / "manifest.json").write_bytes(pretty(manifest))
    print(f"manifest → {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
