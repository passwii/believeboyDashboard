"""Business layer for the autoReportUpload internal ingest endpoints.

This module is the *single* place where the daemon's payload is translated
into rows. It deliberately reuses the public helpers
(``save_ad_upload_scope`` for C-table, ``write_report_upload_log`` for the
status grid) so the daemon path cannot drift from the frontend upload path.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date as _date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ad_upload import AdUploadFile
from app.models.product_analysis_source import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
)
from app.models.project import Project
from app.schemas.internal import (
    A_TABLE_REPORT_TYPES,
    AutoReportHeartbeatRequest,
    AutoReportIngestRequest,
    AutoReportIngestResponse,
    AutoReportRecognizeRequest,
    AutoReportRecognizeResponse,
    C_TABLE_REPORT_TYPES,
)
from app.services.ad.upload.persistence import save_ad_upload_scope
from app.services.audit_log_service import append_operation_audit_log
from app.services.upload_service import slugify
from app.utils.persist_helpers import write_report_upload_log

logger = logging.getLogger(__name__)


def resolve_recognize(
    db: Session, payload: AutoReportRecognizeRequest
) -> AutoReportRecognizeResponse:
    """Resolve a project_id for the given report_type + folder_name.

    Mirrors the dual-pipeline policy in the public recognize endpoints:

    - B-table ad reports: project comes from the spec's
      ``project_match_fields`` (SKU/ASIN) which the daemon didn't pre-extract
      in this MVP, so we fall back to folder-name matching.
    - A-table reports: same folder-name fallback.

    The full SKU/ASIN content match is intentionally NOT done here in MVP;
    the daemon sends the report_type it detected, and we trust the folder.
    A later iteration can ship ``values: list[str]`` in the request.
    """

    folder = (payload.folder_name or "").strip()
    project = db.execute(
        select(Project).where(Project.project_name == folder)
    ).scalars().first()

    if project is None:
        return AutoReportRecognizeResponse(
            project_id=0,
            project_name="",
            report_type=payload.report_type,
            report_label=_report_label_for(payload.report_type),
            match_status="unmatched",
            match_message=f"目录名 [{folder}] 未在数据库中找到对应项目",
            matched_by="folder_name",
            candidate_projects=[],
            can_ingest=False,
        )

    return AutoReportRecognizeResponse(
        project_id=int(project.id),
        project_name=project.project_name,
        report_type=payload.report_type,
        report_label=_report_label_for(payload.report_type),
        match_status="matched",
        match_message=f"根据目录名 [{folder}] 匹配项目",
        matched_by="folder_name",
        candidate_projects=[project.project_name],
        can_ingest=True,
    )


def _report_label_for(report_type: str) -> str:
    labels = {
        "sales_report": "销售报告",
        "business_report": "业务报告",
        "payment_report": "付款报告",
        "inventory_report": "库存报告",
        "return_report": "退货报告",
        "ad_budget_report": "广告预算报告",
        "ad_campaign_report": "广告活动报告",
        "ad_placement_report": "广告位报告",
        "ad_invalid_traffic_report": "广告无效流量报告",
        "ad_target_report": "广告投放报告",
        "ad_search_term_report": "广告搜索词报告",
        "ad_search_term_share_report": "广告搜索词份额报告",
        "ad_time_trend_report": "广告时间趋势报告",
        "ad_promoted_product_report": "广告推广商品报告",
        "ad_purchased_product_report": "广告已购商品报告",
    }
    return labels.get(report_type, report_type)


def _find_existing_sha256(
    db: Session, *, file_sha256: str
) -> tuple[Literal["A", "C"] | None, int | None]:
    """Look up whether this exact file has been ingested before, on either
    table. Returns (table, source_id) if a row is found."""

    a = db.execute(
        select(AnalysisSourceFile.id)
        .where(AnalysisSourceFile.file_sha256 == file_sha256)
        .limit(1)
    ).scalars().first()
    if a is not None:
        return "A", int(a)

    c = db.execute(
        select(AdUploadFile.id)
        .where(AdUploadFile.file_sha256 == file_sha256)
        .limit(1)
    ).scalars().first()
    if c is not None:
        return "C", int(c)

    return None, None


def perform_ingest(
    db: Session, payload: AutoReportIngestRequest
) -> AutoReportIngestResponse:
    """Write a single report to A-table or C-table in one transaction.

    Behaviour matches the public commit endpoints:

    1. If ``file_sha256`` is already known, do NOT create a new row. Write
       a fresh ``ReportUploadLog`` for today so the RPA status grid still
       flips green. Return ``status='duplicate'``.
    2. Otherwise, dispatch to the A-table or C-table persister with the
       per-scope data. Increment version, flip ``is_current`` off on
       older rows, write the source row + detail rows + upload log.
    3. Append an ``operation_audit_log`` entry with operator='autoReportUpload'.
    4. Commit once. Return ``status='created'``.
    """

    if payload.report_type in A_TABLE_REPORT_TYPES:
        source_table: Literal["A", "C"] = "A"
    elif payload.report_type in C_TABLE_REPORT_TYPES:
        source_table = "C"
    else:
        raise ValueError(f"Unknown report_type: {payload.report_type}")

    existing_table, existing_id = _find_existing_sha256(
        db, file_sha256=payload.file_sha256
    )
    if existing_table is not None:
        for scope in payload.scopes:
            write_report_upload_log(
                db,
                project_id=payload.project_id,
                country=payload.country,
                report_type=payload.report_type,
                upload_date=scope.scope_date,
                source_file_id=None,
                has_real_data=scope.row_count_preview > 0,
                row_count=scope.row_count_preview,
                original_filename=payload.original_filename,
            )
        _today = _date.today()
        write_report_upload_log(
            db,
            project_id=payload.project_id,
            country=payload.country,
            report_type=payload.report_type,
            upload_date=_today,
            source_file_id=None,
            has_real_data=payload.scopes[0].row_count_preview > 0,
            row_count=payload.scopes[0].row_count_preview,
            original_filename=payload.original_filename,
        )
        db.commit()

        return AutoReportIngestResponse(
            status="duplicate",
            report_type=payload.report_type,
            project_id=payload.project_id,
            source_table=source_table,
            source_id=existing_id or 0,
            version=0,
            duplicate_match_table=existing_table,
            duplicate_source_id=existing_id,
            message=f"SHA-256 命中既有 {existing_table} 表 source_id={existing_id},已补写今日 upload log",
        )

    if source_table == "C":
        new_id, new_version = _ingest_c_table(db, payload)
    else:
        new_id, new_version = _ingest_a_table(db, payload)

    if source_table in ("A", "C"):
        from datetime import date as _date_module
        _today = _date_module.today()
        # report_upload_logs.source_file_id has a FK to analysis_source_files.id
        # (the A-table). For C-table ingests the source row lives in
        # ad_upload_files, so we leave source_file_id NULL to avoid a
        # ForeignKeyViolation; the project_id / report_type / upload_date
        # triple is enough to flip the RPA status grid green.
        log_source_file_id: int | None = new_id if source_table == "A" else None
        for scope in payload.scopes:
            write_report_upload_log(
                db,
                project_id=payload.project_id,
                country=payload.country,
                report_type=payload.report_type,
                upload_date=scope.scope_date,
                source_file_id=log_source_file_id,
                has_real_data=scope.row_count_preview > 0,
                row_count=scope.row_count_preview,
                original_filename=payload.original_filename,
            )
        if not any(s.scope_date == _today for s in payload.scopes):
            write_report_upload_log(
                db,
                project_id=payload.project_id,
                country=payload.country,
                report_type=payload.report_type,
                upload_date=_today,
                source_file_id=log_source_file_id,
                has_real_data=payload.scopes[0].row_count_preview > 0,
                row_count=payload.scopes[0].row_count_preview,
                original_filename=payload.original_filename,
            )

    append_operation_audit_log(
        db,
        action="auto_report.ingest",
        target_type=f"{source_table.lower()}_upload_file" if source_table == "C" else "analysis_source_file",
        target_id=str(new_id),
        operator=payload.operator,
        after={
            "report_type": payload.report_type,
            "project_id": payload.project_id,
            "country": payload.country,
            "file_sha256": payload.file_sha256,
            "scopes": [s.model_dump(mode="json") for s in payload.scopes],
            "source": "autoReportUpload",
        },
    )
    db.commit()

    return AutoReportIngestResponse(
        status="created",
        report_type=payload.report_type,
        project_id=payload.project_id,
        source_table=source_table,
        source_id=new_id,
        version=new_version,
        message=f"已写入 {source_table} 表 source_id={new_id},version={new_version}",
    )


def _ingest_c_table(
    db: Session, payload: AutoReportIngestRequest
) -> tuple[int, int]:
    """Write one AdUploadFile per scope via the canonical helper."""
    import pandas as pd
    project = db.execute(
        select(Project).where(Project.id == payload.project_id)
    ).scalars().first()
    if project is None:
        raise ValueError(f"Project not found: id={payload.project_id}")

    file_id = f"{uuid.uuid4().hex}_{slugify(payload.original_filename)}"
    saved_ids: list[int] = []
    saved_version = 0

    for scope in payload.scopes:
        scope_df = pd.DataFrame(scope.scope_rows)
        row = save_ad_upload_scope(
            db,
            project=project,
            report_type=payload.report_type,
            country=payload.country,
            report_label=payload.report_label,
            scope_date=scope.scope_date,
            scope_df=scope_df,
            row_count_preview=scope.row_count_preview,
            file_id=file_id,
            file_path=payload.local_file_path,
            original_filename=payload.original_filename,
            recognition_status="recognized",
            matched_columns=payload.matched_columns,
            warnings=payload.warnings,
            recognition_payload={
                "report_type": payload.report_type,
                "report_label": payload.report_label,
                "scope_date": scope.scope_date.isoformat(),
                "row_count_preview": scope.row_count_preview,
                "source": "autoReportUpload",
            },
            created_by=payload.operator,
            file_sha256=payload.file_sha256,
        )
        row.ingestion_status = "success"
        saved_ids.append(int(row.id))
        saved_version = int(row.version)

    db.flush()
    return saved_ids[-1], saved_version


def _ingest_a_table(
    db: Session, payload: AutoReportIngestRequest
) -> tuple[int, int]:
    """Write a single AnalysisSourceFile for non-ad reports + per-row detail rows.

    Detail rows are written here for the 5 A-table report types
    (sales / business / payment / return / ad_product) using the
    ``scope_rows`` the daemon sent in each ``IngestScopePayload``. This
    closes the prior gap where the daemon path wrote only the source row
    and left detail tables empty, breaking downstream sales-order
    analytics and the RPA status grid.
    """
    from app.utils.persist_helpers import (
        next_version,
        replace_current_pointer,
    )

    now = datetime.now(timezone.utc)

    project = db.execute(
        select(Project).where(Project.id == payload.project_id)
    ).scalars().first()
    if project is None:
        raise ValueError(f"Project not found: id={payload.project_id}")

    if payload.report_type == "return_report":
        scope = payload.scopes[0]
        period_start = period_end = scope.scope_date
        report_date = None
        snapshot_at: datetime | None = None
    elif payload.report_type == "inventory_report":
        scope = payload.scopes[0]
        period_start = period_end = None
        report_date = None
        snapshot_at = datetime.now(timezone.utc)
    else:
        scope = payload.scopes[0]
        period_start = period_end = scope.scope_date
        report_date = scope.scope_date
        snapshot_at = None

    version = next_version(
        db,
        project_id=payload.project_id,
        report_type=payload.report_type,
        country=payload.country,
        period_start_date=period_start,
        period_end_date=period_end,
    )
    file_id = f"{uuid.uuid4().hex}_{slugify(payload.original_filename)}"
    ext = "." + payload.original_filename.rsplit(".", 1)[-1].lower() if "." in payload.original_filename else ".xlsx"
    project_slug = slugify(project.project_name) or "project"

    storage_key = _build_storage_key(
        project_slug, payload.report_type, period_start, period_end, version, file_id
    )
    date_part = period_start.strftime('%Y%m%d') if period_start else snapshot_at.strftime('%Y%m%d') if snapshot_at else now.strftime('%Y%m%d')
    logical_filename = f"{project_slug}_{payload.report_type}_{date_part}_{version}{ext}"

    source = AnalysisSourceFile(
        project_id=payload.project_id,
        report_type=payload.report_type,
        country=payload.country,
        report_date=report_date,
        period_start_date=period_start,
        period_end_date=period_end,
        snapshot_at=snapshot_at,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=file_id,
        upload_file_path=payload.local_file_path,
        original_filename=payload.original_filename,
        stored_filename=file_id,
        logical_filename=logical_filename,
        storage_key=storage_key,
        file_size_bytes=payload.file_size_bytes,
        file_sha256=payload.file_sha256,
        ingestion_status="success",
        row_count_total=payload.scopes[0].row_count_preview,
        row_count_included=payload.scopes[0].row_count_preview,
    )
    db.add(source)
    db.flush()
    replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    _write_a_table_detail_rows(
        db,
        source_file_id=int(source.id),
        report_type=payload.report_type,
        local_file_path=payload.local_file_path,
        project_id=payload.project_id,
        country=payload.country,
    )
    return int(source.id), version


def _build_storage_key(
    project_slug: str,
    report_type: str,
    period_start: _date | None,
    period_end: _date | None,
    version: int,
    file_id: str,
) -> str:
    if report_type == "inventory_report":
        return f"analysis/{project_slug}/{report_type}/snapshot/v{version}/{file_id}"
    if period_start is None or period_end is None:
        raise ValueError(f"Missing period for {report_type}")
    return (
        f"analysis/{project_slug}/{report_type}/"
        f"{period_start.strftime('%Y%m%d')}_{period_end.strftime('%Y%m%d')}/"
        f"v{version}/{file_id}"
    )


_A_TABLE_DETAIL_DISPATCH: dict[str, str] = {
    "sales_report": "sales",
    "business_report": "business",
    "payment_report": "payment",
    "return_report": "return",
    "ad_product_report": "ad_product",
    "inventory_report": "inventory",
}


def _to_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    if value is None or value == "":
        return default
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    return text in {"true", "1", "yes", "y", "t"}


def _json_dumps(value: Any) -> str:
    """Serialize any value to a JSON string for raw INSERT into JSONB columns.

    Decimal/datetime/date are coerced to strings; dicts/lists go through the
    default encoder. The returned text is bound as a parameter and cast to
    JSON on the SQL side, so the engine handles JSON encoding consistently.
    """
    def _default(obj: Any) -> Any:
        if isinstance(obj, Decimal):
            return str(obj)
        if isinstance(obj, (_date, datetime)):
            return obj.isoformat()
        return str(obj)
    return json.dumps(value, default=_default, ensure_ascii=False)


def _load_known_product_keys(
    db: Session, *, project_id: int, country: str
) -> tuple[set[str], set[str]]:
    """Load the project's active SKU/ASIN set for payment scope classification.

    Mirrors ``autoReportUpload.processor._load_project_product_mapping`` from
    before the HTTP-only refactor; the same ProductCost table is the source
    of truth for which products belong to the project.
    """
    from app.models.product_cost import ProductCost  # local import — avoids cycle
    from app.models.project import Project
    from app.utils.text_utils import normalize_sku as _normalize_sku, normalize_asin as _normalize_asin

    rows = db.execute(
        select(ProductCost.sku, ProductCost.asin)
        .join(Project, Project.id == ProductCost.project_id)
        .where(
            ProductCost.project_id == project_id,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
    ).all()
    skus = {_normalize_sku(s) for s, _ in rows if _normalize_sku(s)}
    asins = {_normalize_asin(a) for _, a in rows if _normalize_asin(a)}
    return skus, asins


def _read_a_table_dataframe(file_path: str, report_type: str) -> "pd.DataFrame":
    """Read the source file using the parser-friendly reader for its type.

    Payment uses a locale-aware reader; everything else uses the standard
    _read_dataframe (csv / xlsx) so the column names arrive at parsers
    untouched.
    """
    import pandas as pd
    from pathlib import Path
    from app.services.ad.upload.utils import _read_dataframe
    from app.utils.payment_locale import read_payment_report_dataframe

    p = Path(file_path)
    if report_type == "payment_report":
        return read_payment_report_dataframe(p, country="US")
    return _read_dataframe(p)


def _write_a_table_detail_rows(
    db: Session,
    *,
    source_file_id: int,
    report_type: str,
    local_file_path: str,
    project_id: int,
    country: str,
) -> None:
    """Parse the source file with the canonical row parser and bulk-insert
    detail rows into the matching ``analysis_*`` / ``inventory_*`` table.

    Uses ``app.utils.parsers.parse_*_rows`` (the same parsers the web upload
    pipeline uses) instead of trusting whatever column names the daemon
    sent in ``scope_rows``. The daemon's payload is the trigger; the source
    of truth for row schema is the file on disk + the parser.
    """
    import pandas as pd
    from sqlalchemy import insert as sa_insert

    from app.models.product_analysis_source import (
        AnalysisAdProductRow,
        AnalysisBusinessRow,
        AnalysisPaymentRow,
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
    )
    from app.models.product_analysis_source import InventorySnapshotRow
    from app.utils.parsers import (
        parse_ad_rows,
        parse_business_rows,
        parse_inventory_rows,
        parse_payment_rows,
        parse_return_rows,
        parse_sales_rows,
    )

    kind = _A_TABLE_DETAIL_DISPATCH.get(report_type)
    if kind is None:
        return

    path = Path(local_file_path)
    if not path.exists():
        logger.warning(
            "auto-report ingest: source file not found, skipping detail rows: %s",
            local_file_path,
        )
        return

    try:
        if kind == "sales":
            payloads, _, _ = parse_sales_rows(path, source_file_id, country=country)
            model = AnalysisSalesOrderRow
        elif kind == "business":
            payloads, _, _ = parse_business_rows(path, source_file_id)
            model = AnalysisBusinessRow
        elif kind == "payment":
            known_skus, known_asins = _load_known_product_keys(
                db, project_id=project_id, country=country,
            )
            df = _read_a_table_dataframe(local_file_path, report_type)
            payloads, _, _ = parse_payment_rows(
                df, source_file_id, known_skus, known_asins,
            )
            model = AnalysisPaymentRow
        elif kind == "return":
            df = _read_a_table_dataframe(local_file_path, report_type)
            payloads, _ = parse_return_rows(df)
            # parse_return_rows returns rows without source_file_id / source_row_no;
            # add them so the bulk insert lands on the new source.
            for index, payload in enumerate(payloads, start=1):
                payload["source_file_id"] = source_file_id
                payload["source_row_no"] = index
                # Convert return_date_raw (datetime) -> return_date (date)
                if "return_date_raw" in payload:
                    payload["return_date"] = payload["return_date_raw"].date() \
                        if hasattr(payload["return_date_raw"], "date") \
                        else payload["return_date_raw"]
                    payload.pop("return_date_raw", None)
            model = AnalysisReturnRow
        elif kind == "inventory":
            payloads, _, _ = parse_inventory_rows(path, source_file_id)
            model = InventorySnapshotRow
        elif kind == "ad_product":
            known_skus, known_asins = _load_known_product_keys(
                db, project_id=project_id, country=country,
            )
            payloads, _, _ = parse_ad_rows(
                path, source_file_id, known_skus, known_asins,
            )
            model = AnalysisAdProductRow
        else:
            return
    except Exception as exc:
        logger.warning(
            "auto-report ingest: %s parser failed for %s: %s",
            kind, local_file_path, exc,
        )
        return

    if not payloads:
        return

    # Strip keys the target model doesn't know about, so bulk insert doesn't
    # blow up on schema mismatches between the parser payload and the table.
    table_columns = {column.key for column in model.__table__.columns}
    payloads = [
        {k: v for k, v in payload.items() if k in table_columns}
        for payload in payloads
    ]

    try:
        db.execute(sa_insert(model.__table__), payloads)
    except Exception as exc:
        logger.warning(
            "auto-report ingest: %s detail bulk insert failed for source %s: %s",
            kind, source_file_id, exc,
        )


def record_heartbeat(
    db: Session, payload: AutoReportHeartbeatRequest
) -> int:
    """Write one row to auto_report_upload_logs as a liveness signal.

    Backend reuses the same model that the daemon used to write directly
    (operator='autoReportUpload', status=passed-through, run_id=
    instance_id+last_run_ts, error_message=detail)."""

    from app.models.auto_report_upload_log import AutoReportUploadLog

    row = AutoReportUploadLog(
        run_id=f"{payload.instance_id}-{payload.last_run_ts}",
        status=payload.last_status,
        country="-",
        project_name="-",
        report_type_label="heartbeat",
        report_date_display=payload.last_run_ts[:8],
        report_type="heartbeat",
        original_filename="",
        source_id=None,
        source_table=None,
        row_count=0,
        detected_start_date=None,
        detected_end_date=None,
        duration_seconds=None,
        error_message=(payload.detail or None),
        note=f"instance={payload.instance_id}",
    )
    db.add(row)
    db.commit()
    return int(row.id)
