#!/usr/bin/env python3
# pyright: reportMissingImports=false
#
# ↑ `app.*` 只在**运行时**可导入：脚本把 `backend/` 插进 `sys.path` 后才 import（见
# `main()`）。静态分析器按仓库根解析不到 `backend/app` 这个包名，这不是缺陷 —— 故在这里
# 关掉这一条，而不是把 import 改成难以阅读的 `importlib.import_module` 字符串。
"""抓取「报表中心 · 上传与分析簇」端点的**真实后端响应**快照（BLF-1068，macOS Stage 5.5）。

用途：把「同源同值」（issue 验收 1）与「识别 / 入库 / 任务状态的响应形状」变成可执行断言。
`ReportDecodingTests` / `ReportClientTests` / `ProductAnalysisStoreTests` /
`ReportAutomationStoreTests` 拿这里落盘的响应去断言字段名与数值口径，后端改名或形状漂移
会在测试里报红。

口径（与 `Fixtures/Report/README.md` 一致，改了这里就要同步改那里）：

* 鉴权：`X-API-Key`（主 key，取 settings.api_key）+ `X-Is-Admin: true` + `X-Operator: admin`，
  与 S5.1 / S5.2 / S5.3 三批同一组账号上下文。
* **没有任何写业务表的请求**：
  - `ad-upload/recognize` 只把文件复制到 `upload_root/_ad_upload_tmp/`（磁盘临时区），
    后端不写任何表（`recognize_saved_ad_upload` 里没有一次 `db.add/commit`）；
  - `ad-upload/commit` 用 **`dry_run: true`** —— 与 Web 两处手动核算面板逐字一致，
    后端注释明写「不写入 ad_upload_files / ad_upload_promoted_product_rows，不占版本号」；
  - `product-analysis-reports` 的 POST 会写一条 `operation_audit_log`，故这一条**只在隔离库
    `BLF_test`** 上跑（生产快照库 `BLF` 一个字节都不写）。
* 抓完清理：`_ad_upload_tmp/` 与 `_ad_upload/` 下本次产生的文件、以及 `BLF_test` 里本次
  产生的审计行，都在 `finally` 里删掉。

数据来源分两段（**这是本批与 S5.1~S5.3 最大的差异，必须写清楚**）：

| 段 | 端点 | 库 | 理由 |
| --- | --- | --- | --- |
| A | `GET /rpa-reports/status`、`GET /ad-upload/status`、`POST /ad-upload/recognize`、`POST /ad-upload/commit`（dry_run） | 生产快照库 `BLF` | 这四条**只读业务表**（commit 走 dry_run），生产快照里有 14412 行 `ad_upload_files`，与 Web 同源 |
| B | `POST /product-analysis-reports`、`GET .../tasks/{id}`、`GET .../tasks/{id}/result` | 隔离库 `BLF_test` | POST 会写审计日志；且任务失败态需要真跑一次（见下） |

段 B 的「真跑一次」：POST 用的是**不存在的 file_id**，后台线程在建任务后立刻以
`FileNotFoundError` 失败（`app/tasks/scripts/product_analysis.py` 的路径预检），
于是拿到的是**真实路由序列化出来的 failed 状态**，而不是手写的 JSON。
结果端点此时回真实的 409。

用法：

    python3 macos/scripts/capture-report-fixtures.py                  # 写入默认目录
    python3 macos/scripts/capture-report-fixtures.py --out <dir>      # 写别处（复核漂移用）

重抓后必须同时更新 manifest 的 `sha256` / `bytes` / `captured_at`，并在 PR 里写明新的哈希
—— `ReportDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_OUT = REPO_ROOT / "macos" / "Tests" / "BelieveBoyTests" / "Fixtures" / "Report"

COUNTRY = "US"
#: `GET /ad-upload/status` 的 limit（页面口径 = 后端默认值 50）。
AD_UPLOAD_STATUS_LIMIT = 50
#: `rpa-reports/status` 的日期探测窗口（往前找有数据的那一天）。
RPA_DATE_LOOKBACK_DAYS = 21

#: 合成广告报表用的固定文件名（决定 `extension` 字段与识别分流）。
SYNTHETIC_FILENAME = "广告推广的商品报告-测试夹具.csv"

#: 段 B 的待提交请求（file_id 刻意不存在 —— 任务必然失败，但不写任何业务表）。
SEGMENT_B_PROJECT = "夹具项目"
SEGMENT_B_START = "2026-08-31"
SEGMENT_B_END = "2026-09-06"
SEGMENT_B_BUSINESS_FILE_ID = "blf1068fixture_business_report.csv"
SEGMENT_B_PAYMENT_FILE_ID = "blf1068fixture_payment_report.csv"
SEGMENT_B_AD_FILE_ID = "blf1068fixture_ad_report.csv"


def pretty(payload: object) -> bytes:
    """落盘形态：2 空格缩进 + 键排序 —— 夹具要能被人工 `diff` / `jq` 复查。

    仅做一处归一化：把**仓库根的绝对路径**换成 `<repo>`。理由是夹具要进 git、要在别人的机器
    上跑，而 `file_path` / `error_message` 两个字段里确实带着本机路径（真实响应就该有）；
    换掉路径前缀不影响任何被断言的字段（类型 / 数值 / 字段名），却让夹具与机器无关。
    两处路径的原文都能从本脚本或后端代码复现，信息没有丢失。
    """
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    text = text.replace(str(REPO_ROOT), "<repo>")
    return (text + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def testing_database_url(production_url: str) -> str:
    """生产库 URL → 隔离库 URL（只换库名，其余连接参数不动）。"""
    head, _, _ = production_url.rpartition("/")
    return f"{head}/BLF_test"


def default_database_url() -> str:
    """本机 Postgres 的默认连接串（仓库里没有 `backend/.env` 时的兜底）。

    与 `backend/.env.example` 同一形状，只是把库名指到生产快照库 `BLF`。
    """
    user = os.environ.get("PGUSER") or os.environ.get("USER") or "postgres"
    return f"postgresql+psycopg://{user}@127.0.0.1:5432/BLF"


def build_synthetic_ad_report(sku: str, asin: str, campaign: str, group: str) -> bytes:
    """一份**能被真实识别器认出来**的广告报表（`ad_promoted_product_report`）。

    表头照抄 `app/services/ad/upload/specs.py` 的 `required_columns`（开始日期 / 结束日期 /
    广告SKU / 广告ASIN / 广告活动名称 / 广告组名称）；SKU 与 ASIN 取自生产快照库里**同一个
    项目**的真实行，好让 `project_match` 落在 `matched` 上（否则夹具只能钉「未匹配」分支）。
    """
    rows = [
        "开始日期,结束日期,广告SKU,广告ASIN,广告活动名称,广告组名称",
        f"2026-09-07,2026-09-07,{sku},{asin},{campaign},{group}",
        f"2026-09-08,2026-09-08,{sku},{asin},{campaign},{group}",
    ]
    return ("\n".join(rows) + "\n").encode("utf-8")


def pick_sku_asin(session) -> tuple[str, str, str, str]:
    """取一条真实 (sku, asin, 项目, 站点) —— 用于让识别出的项目匹配落在 `matched`。"""
    from app.models.project import Project
    from app.models.sku_info import SkuRecord
    from sqlalchemy import select

    stmt = (
        select(Project.project_name, SkuRecord.sku, SkuRecord.asin)
        .join(SkuRecord, SkuRecord.project_id == Project.id)
        .where(SkuRecord.country == COUNTRY)
        .where(SkuRecord.is_active.is_(True))
        .where(Project.is_active.is_(True))
        .where(SkuRecord.sku.is_not(None))
        .where(SkuRecord.asin.is_not(None))
        .order_by(Project.project_name, SkuRecord.sku)
        .limit(1)
    )
    row = session.execute(stmt).first()
    if row is None:
        raise SystemExit("生产快照库里找不到可用的 (project, sku, asin) —— 夹具无法构造")
    project_name, sku, asin = row
    return str(sku), str(asin), str(project_name), "夹具广告活动"


def cleanup_upload_dirs(settings) -> None:
    """删掉本次抓取在 `upload_root` 下造的两个临时区（gitignore 覆盖 `/backend/storage/`）。

    只删 `_ad_upload_tmp`（`recognize` 的落地点）与 `_ad_upload`（`commit` 的落地点）——
    它们是本次抓取**唯一**会创建的两个目录；整个 `upload_root` 不动（里面可能还有
    其他人的东西）。

    清理失败**不能**让整个抓取失败：夹具已经落盘，删不掉临时目录最多是留几个文件。
    """
    for name in ("_ad_upload_tmp", "_ad_upload"):
        target = settings.upload_root / name
        try:
            shutil.rmtree(target, ignore_errors=True)
        except OSError as error:
            print(f"[warn] 清理 {target} 失败（不影响夹具）：{error}", file=sys.stderr)


def require(condition: object, message: str) -> None:
    """显式断言（不用 `assert`：`-O` 会把它抹掉，而这条检查是夹具可信度的前提）。"""
    if not condition:
        raise SystemExit(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出目录")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(BACKEND_DIR))

    production_url = os.environ.get("DATABASE_URL") or default_database_url()
    test_url = testing_database_url(production_url)
    os.environ["DATABASE_URL"] = production_url
    os.environ.pop("TEST_DATABASE_URL", None)
    os.environ.setdefault("API_KEY", "blf-1068-fixture-master-key")

    os.environ["DATABASE_READ_URL"] = production_url

    from app.core.config import get_settings  # noqa: E402

    production_settings = get_settings()
    require(
        production_settings.database_url.endswith("/BLF"),
        f"段 A 必须跑在生产快照库 BLF 上，实际是 {production_settings.database_url}",
    )

    headers_base = {"X-Is-Admin": "true", "X-Operator": "admin"}
    files: list[dict[str, object]] = []

    def record_json(name: str, payload: object, endpoint: str, note: str) -> None:
        # 文件名全部是本文件里的字面量；仍然挡一道目录分隔符 —— 夹具落盘路径不该由参数决定。
        require("/" not in name and "\\" not in name and name not in {"", ".", ".."}, f"非法文件名：{name}")
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
        print(f"{name:44s} {len(body):8d} B  {sha256(body)[:16]}")

    from app.db.session import SessionLocal  # noqa: E402
    from app.main import app as prod_app  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402

    prod_headers = {"X-API-Key": production_settings.api_key, **headers_base}
    client = TestClient(prod_app)

    rpa_date = None
    rpa_payload = None
    try:
        # ---------------------------------------------------------------- A1：RPA 状态矩阵
        # 往前找一天「有上传数据」的日期 —— 夹具要覆盖非空表，而不是靠运气抓一天空的。
        for offset in range(RPA_DATE_LOOKBACK_DAYS):
            candidate = (date.today() - timedelta(days=offset)).isoformat()
            response = client.get(
                "/api/v1/rpa-reports/status",
                params={"report_date": candidate, "country": COUNTRY},
                headers=prod_headers,
            )
            response.raise_for_status()
            payload = response.json()
            uploaded = sum(
                1
                for item in payload.get("items", [])
                for status in item.get("statuses", [])
                if status.get("is_uploaded")
            )
            if uploaded > 0:
                rpa_date, rpa_payload = candidate, payload
                break
        if rpa_payload is None:
            raise SystemExit(f"往前 {RPA_DATE_LOOKBACK_DAYS} 天都没有已上传的 RPA 报表，无法抓夹具")

        project_count = len(rpa_payload["items"])
        uploaded_total = sum(
            1
            for item in rpa_payload["items"]
            for status in item["statuses"]
            if status["is_uploaded"]
        )
        record_json(
            "rpa-status.json",
            rpa_payload,
            "GET /api/v1/rpa-reports/status",
            f"report_date={rpa_date} country={COUNTRY}；项目 {project_count} 个、"
            f"已上传格 {uploaded_total} 个",
        )

        # ------------------------------------------------------------ A2：广告入库状态
        status_response = client.get(
            "/api/v1/ad-upload/status",
            params={"country": COUNTRY, "limit": AD_UPLOAD_STATUS_LIMIT},
            headers=prod_headers,
        )
        status_response.raise_for_status()
        status_payload = status_response.json()
        record_json(
            "ad-upload-status.json",
            status_payload,
            "GET /api/v1/ad-upload/status",
            f"country={COUNTRY} limit={AD_UPLOAD_STATUS_LIMIT}；items="
            f"{len(status_payload.get('items', []))}（上限截断口径：顶到 limit 即可能被截断）",
        )

        # 第二种固定参数：按项目 + 报表类型过滤（同一端点的另一种形状）。
        first_item = status_payload["items"][0] if status_payload.get("items") else None
        if first_item is not None:
            filtered_response = client.get(
                "/api/v1/ad-upload/status",
                params={
                    "country": COUNTRY,
                    "limit": AD_UPLOAD_STATUS_LIMIT,
                    "project_name": first_item["project_name"],
                    "report_type": first_item["report_type"],
                },
                headers=prod_headers,
            )
            filtered_response.raise_for_status()
            filtered_payload = filtered_response.json()
            record_json(
                "ad-upload-status-filtered.json",
                filtered_payload,
                "GET /api/v1/ad-upload/status?project_name=&report_type=",
                f"project_name={first_item['project_name']} report_type={first_item['report_type']}；"
                f"items={len(filtered_payload.get('items', []))}",
            )

        # ------------------------------------------------- A3：识别（multipart，真发一次）
        session = SessionLocal()
        try:
            sku, asin, fixture_project, campaign = pick_sku_asin(session)
        finally:
            session.close()

        csv_body = build_synthetic_ad_report(sku, asin, campaign, "夹具广告组")
        synthetic_path = args.out / "synthetic-source.csv"
        synthetic_path.write_bytes(csv_body)

        recognize_response = client.post(
            "/api/v1/ad-upload/recognize",
            files={"file": (SYNTHETIC_FILENAME, csv_body, "text/csv")},
            data={"country": COUNTRY},
            headers=prod_headers,
        )
        recognize_response.raise_for_status()
        recognition = recognize_response.json()
        record_json(
            "ad-upload-recognize.json",
            recognition,
            "POST /api/v1/ad-upload/recognize",
            f"multipart（file + country={COUNTRY}）；合成表头来自真实识别规则 "
            f"（ad_promoted_product_report），SKU/ASIN 取自真实项目「{fixture_project}」→ "
            f"project_match.status={recognition['project_match']['status']}、"
            f"row_count_preview={recognition['row_count_preview']}",
        )

        # ---------------------------------------- A4：入库（dry_run，不写业务表 / 不占版本号）
        commit_response = client.post(
            "/api/v1/ad-upload/commit",
            json={
                "temp_file_id": recognition["temp_file_id"],
                "report_type": recognition["report_type"],
                "original_filename": SYNTHETIC_FILENAME,
                "project_name": fixture_project,
                "country": COUNTRY,
                "report_start_date": recognition["detected_start_date"],
                "report_end_date": recognition["detected_end_date"],
                "dry_run": True,
            },
            headers=prod_headers,
        )
        commit_response.raise_for_status()
        commit_payload = commit_response.json()
        record_json(
            "ad-upload-commit-dry-run.json",
            commit_payload,
            "POST /api/v1/ad-upload/commit（dry_run=true）",
            f"ingestion_status={commit_payload['ingestion_status']}（skipped = 未入库）、"
            f"id={commit_payload['id']}、version={commit_payload['version']}；"
            "这是本批写链路 commit 的真实形状",
        )

        # 识别 / 入库的失败路径（真实错误体，客户端要能原样显示中文 detail）。
        unsupported_response = client.post(
            "/api/v1/ad-upload/recognize",
            files={"file": ("report.pdf", b"%PDF-1.4\n", "application/pdf")},
            data={"country": COUNTRY},
            headers=prod_headers,
        )
        record_json(
            "ad-upload-recognize-unsupported-extension.json",
            {"status": unsupported_response.status_code, "body": unsupported_response.json()},
            "POST /api/v1/ad-upload/recognize（.pdf）",
            "真实 400（扩展名不在 ALLOWED_EXTENSIONS）；客户端据此提示「不支持的文件类型」",
        )

        unknown_header_response = client.post(
            "/api/v1/ad-upload/recognize",
            files={"file": ("随便一个报表.csv", "列A,列B\n1,2\n".encode(), "text/csv")},
            data={"country": COUNTRY},
            headers=prod_headers,
        )
        record_json(
            "ad-upload-recognize-unknown-headers.json",
            {
                "status": unknown_header_response.status_code,
                "body": unknown_header_response.json(),
            },
            "POST /api/v1/ad-upload/recognize（表头不命中规则）",
            "真实 400「未命中广告报表识别规则」；客户端据此把该文件标成识别失败而不是静默丢弃",
        )

        mismatch_response = client.post(
            "/api/v1/ad-upload/commit",
            json={
                "temp_file_id": recognition["temp_file_id"],
                "report_type": "ad_campaign_report",
                "original_filename": SYNTHETIC_FILENAME,
                "project_name": fixture_project,
                "country": COUNTRY,
                "report_start_date": recognition["detected_start_date"],
                "report_end_date": recognition["detected_end_date"],
                "dry_run": True,
            },
            headers=prod_headers,
        )
        record_json(
            "ad-upload-commit-type-mismatch.json",
            {"status": mismatch_response.status_code, "body": mismatch_response.json()},
            "POST /api/v1/ad-upload/commit（report_type 与识别不一致）",
            "真实 422；客户端把识别出的 report_type 原样回传，不该出现这一条 —— 留着钉契约",
        )
    finally:
        client.close()
        cleanup_upload_dirs(production_settings)

    # ------------------------------------------ 段 B：隔离库 BLF_test（POST 会写审计日志）
    os.environ["DATABASE_URL"] = test_url
    os.environ["DATABASE_READ_URL"] = test_url
    for module in [m for m in list(sys.modules) if m.startswith("app.")]:
        del sys.modules[module]

    from app.core.config import get_settings as test_settings  # noqa: E402
    from app.db.session import SessionLocal as TestSessionLocal  # noqa: E402
    from app.main import app as test_app  # noqa: E402
    from app.models.operation_audit_log import OperationAuditLog  # noqa: E402
    from sqlalchemy import delete  # noqa: E402

    test_config = test_settings()
    require(
        test_config.database_url.endswith("/BLF_test"),
        f"段 B 必须跑在隔离库 BLF_test 上，实际是 {test_config.database_url}",
    )
    test_headers = {"X-API-Key": test_config.api_key, **headers_base}

    audit_ids: list[int] = []
    test_client = TestClient(test_app)
    try:
        create_response = test_client.post(
            "/api/v1/product-analysis-reports",
            json={
                "project_name": SEGMENT_B_PROJECT,
                "report_start_date": SEGMENT_B_START,
                "report_end_date": SEGMENT_B_END,
                "business_report_file_id": SEGMENT_B_BUSINESS_FILE_ID,
                "payment_report_file_id": SEGMENT_B_PAYMENT_FILE_ID,
                "ad_report_file_id": SEGMENT_B_AD_FILE_ID,
                "country": COUNTRY,
            },
            headers=test_headers,
        )
        create_response.raise_for_status()
        ticket = create_response.json()
        record_json(
            "product-analysis-report-create.json",
            ticket,
            "POST /api/v1/product-analysis-reports",
            f"真实 202/200 形态（job_id={ticket['job_id']}）；file_id 刻意不存在 → "
            "后台线程会以 FileNotFoundError 失败，故不写任何业务表",
        )

        # 任务状态：轮询到终态（后台线程立刻失败，通常 1 次探测就到）。
        task_payload = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            task_response = test_client.get(
                f"/api/v1/product-analysis-reports/tasks/{ticket['job_id']}",
                headers=test_headers,
            )
            task_response.raise_for_status()
            task_payload = task_response.json()
            if task_payload["status"] in {"success", "failed"}:
                break
            time.sleep(0.3)
        if task_payload is None:
            raise SystemExit("任务状态轮询超时（30s）——夹具无法落盘")
        require(
            task_payload["status"] == "failed",
            f"段 B 的任务应当以 failed 收尾（缺文件），实际是 {task_payload['status']}",
        )
        record_json(
            "product-analysis-task-failed.json",
            task_payload,
            "GET /api/v1/product-analysis-reports/tasks/{task_id}",
            "真实 failed 终态（缺文件 → FileNotFoundError）；progress/100、"
            "persistence_status=idle —— 客户端的状态机据此判终态",
        )

        # 结果：任务未成功 → 真实 409。
        result_response = test_client.get(
            f"/api/v1/product-analysis-reports/tasks/{ticket['job_id']}/result",
            headers=test_headers,
        )
        record_json(
            "product-analysis-result-not-ready.json",
            {"status": result_response.status_code, "body": result_response.json()},
            "GET /api/v1/product-analysis-reports/tasks/{task_id}/result",
            "真实 409「Task not finished」；客户端据此拒绝下载并保留进度",
        )

        # 不存在的任务 → 真实 404（客户端要把「任务不在这个进程里」与「还在跑」分开说）。
        missing_response = test_client.get(
            "/api/v1/product-analysis-reports/tasks/999999999",
            headers=test_headers,
        )
        record_json(
            "product-analysis-task-not-found.json",
            {"status": missing_response.status_code, "body": missing_response.json()},
            "GET /api/v1/product-analysis-reports/tasks/{不存在的 id}",
            "真实 404（任务表是**进程内字典**，多 worker 部署下会命中这一条）",
        )
    finally:
        test_client.close()
        session = TestSessionLocal()
        try:
            from sqlalchemy import select as _select

            rows = session.execute(
                _select(OperationAuditLog.id).where(
                    OperationAuditLog.action == "product_analysis_reports.create"
                )
            ).scalars().all()
            if rows:
                session.execute(delete(OperationAuditLog).where(OperationAuditLog.id.in_(rows)))
                session.commit()
            audit_ids = [int(item) for item in rows]
        finally:
            session.close()

    # 合成源文件不落 git（夹具只保留后端**响应**；源文件可由本脚本随时重建）。
    synthetic_path.unlink(missing_ok=True)

    manifest = {
        "captured_at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "captured_by": "BLF-1068（macOS Stage 5.5 报表中心 · 上传与分析簇）",
        "auth": "X-API-Key（主 key）+ X-Is-Admin: true + X-Operator: admin",
        "capture_script": "macos/scripts/capture-report-fixtures.py（无业务表写请求；commit 走 dry_run）",
        "normalization": (
            "仅一处：响应文本里的仓库根绝对路径 → `<repo>`（`file_path` / `error_message` 带本机路径，"
            "归一化后夹具与机器无关；字段名 / 类型 / 数值一律原样）"
        ),
        "params": {
            "country": COUNTRY,
            "rpa_report_date": rpa_date,
            "ad_upload_status_limit": AD_UPLOAD_STATUS_LIMIT,
            "synthetic_ad_report": {
                "filename": SYNTHETIC_FILENAME,
                "report_type": "ad_promoted_product_report",
                "sku": sku,
                "asin": asin,
                "project": fixture_project,
            },
        },
        "source_a": {
            "database": "生产快照库 BLF（等价 backend/.env 的 DATABASE_URL）",
            "endpoints": [
                "GET /api/v1/rpa-reports/status",
                "GET /api/v1/ad-upload/status",
                "POST /api/v1/ad-upload/recognize",
                "POST /api/v1/ad-upload/commit（dry_run=true）",
            ],
            "note": (
                "与 S5.1~S5.3 同源（生产快照库）。识别的源文件是**合成**的（表头照抄识别规则、"
                "SKU/ASIN 取真实行），响应本身 100% 由后端识别器产出；commit 用 dry_run，"
                "识别 / 入库用的临时文件抓完即删，未写任何业务表。"
            ),
        },
        "source_b": {
            "database": "隔离库 BLF_test（生产 URL 换库名）",
            "endpoints": [
                "POST /api/v1/product-analysis-reports",
                "GET /api/v1/product-analysis-reports/tasks/{task_id}",
                "GET /api/v1/product-analysis-reports/tasks/{task_id}/result",
            ],
            "note": (
                "POST 会写一条 operation_audit_log（抓完即删，已记录删除的 id 数：" +
                f"{len(audit_ids)}）；任务失败态是真跑出来的（缺文件），不是手写 JSON。"
            ),
        },
        "files": files,
    }
    (args.out / "manifest.json").write_bytes(pretty(manifest))
    print(f"manifest → {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
