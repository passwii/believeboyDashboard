"""fix non-us sales timezone dates

Revision ID: 20260409_083
Revises: add_token_stats_conv
Create Date: 2026-04-09 15:30:00.000000
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime
from typing import Sequence, Union
from zoneinfo import ZoneInfo

from alembic import op
import sqlalchemy as sa


revision: str = "20260409_083"
down_revision: Union[str, None] = "add_token_stats_conv"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


COUNTRY_TIMEZONE = {
    "DE": ZoneInfo("Europe/Berlin"),
    "UK": ZoneInfo("Europe/London"),
}


def _safe_suffix(base: str | None, suffix: str, limit: int) -> str:
    text = (base or "").strip()
    if not text:
        text = "sales_report"
    out = f"{text}{suffix}"
    if len(out) <= limit:
        return out
    keep = max(0, limit - len(suffix))
    return f"{text[:keep]}{suffix}"[:limit]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    required_tables = {"analysis_source_files", "analysis_sales_order_rows"}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    metadata = sa.MetaData()
    sources = sa.Table("analysis_source_files", metadata, autoload_with=bind)
    sales_rows = sa.Table("analysis_sales_order_rows", metadata, autoload_with=bind)

    source_records = bind.execute(
        sa.select(
            sources.c.id,
            sources.c.project_id,
            sources.c.country,
            sources.c.report_date,
            sources.c.period_start_date,
            sources.c.period_end_date,
            sources.c.version,
            sources.c.upload_file_id,
            sources.c.upload_file_path,
            sources.c.original_filename,
            sources.c.stored_filename,
            sources.c.logical_filename,
            sources.c.storage_key,
            sources.c.file_size_bytes,
            sources.c.file_sha256,
            sources.c.ingestion_status,
            sources.c.ingestion_error,
            sources.c.created_by,
        )
        .where(sources.c.report_type == "sales_report")
        .where(sources.c.country.in_(["DE", "UK"]))
        .order_by(sources.c.id.asc())
    ).mappings().all()

    if not source_records:
        return

    fixed_rows = 0
    updated_sources = 0
    split_sources = 0

    now = datetime.now(UTC)

    for source in source_records:
        country = str(source["country"])
        timezone = COUNTRY_TIMEZONE.get(country)
        if timezone is None:
            continue

        row_records = bind.execute(
            sa.select(
                sales_rows.c.id,
                sales_rows.c.purchase_at_utc,
                sales_rows.c.is_counted_sales,
            ).where(sales_rows.c.source_file_id == source["id"])
        ).mappings().all()
        if not row_records:
            continue

        by_date: dict[date, list[int]] = defaultdict(list)
        counted_by_date: dict[date, int] = defaultdict(int)

        for row in row_records:
            purchase_at_utc = row["purchase_at_utc"]
            if purchase_at_utc is None:
                continue
            local_aware = purchase_at_utc.astimezone(timezone)
            local_date = local_aware.date()
            local_naive = local_aware.replace(tzinfo=None)
            bind.execute(
                sa.update(sales_rows)
                .where(sales_rows.c.id == row["id"])
                .values(
                    purchase_at_pt=local_naive,
                    purchase_date_pt=local_date,
                )
            )
            fixed_rows += 1
            by_date[local_date].append(int(row["id"]))
            if bool(row["is_counted_sales"]):
                counted_by_date[local_date] += 1

        if not by_date:
            continue

        unique_dates = sorted(by_date.keys())
        kept_source_as_target = False
        if len(unique_dates) > 1:
            split_sources += 1

        for target_date in unique_dates:
            if (
                source["period_start_date"] == target_date
                and source["period_end_date"] == target_date
            ):
                target_source_id = int(source["id"])
            else:
                existing_target_id = bind.execute(
                    sa.select(sources.c.id)
                    .where(sources.c.project_id == source["project_id"])
                    .where(sources.c.report_type == "sales_report")
                    .where(sources.c.country == country)
                    .where(sources.c.period_start_date == target_date)
                    .where(sources.c.period_end_date == target_date)
                    .where(sources.c.is_current.is_(True))
                    .where(sources.c.id != source["id"])
                    .order_by(sources.c.id.desc())
                    .limit(1)
                ).scalar_one_or_none()

                if existing_target_id is not None:
                    target_source_id = int(existing_target_id)
                else:
                    next_version = int(
                        bind.execute(
                            sa.select(sa.func.coalesce(sa.func.max(sources.c.version), 0) + 1)
                            .where(sources.c.project_id == source["project_id"])
                            .where(sources.c.report_type == "sales_report")
                            .where(sources.c.country == country)
                            .where(sources.c.period_start_date == target_date)
                            .where(sources.c.period_end_date == target_date)
                        ).scalar_one()
                    )
                    logical_filename = _safe_suffix(
                        source["logical_filename"],
                        f".tzfix-{target_date.isoformat()}-v{next_version}",
                        255,
                    )
                    storage_key = _safe_suffix(
                        source["storage_key"],
                        f"/tzfix-{target_date.isoformat()}-v{next_version}",
                        1024,
                    )
                    insert_result = bind.execute(
                        sa.insert(sources)
                        .values(
                            project_id=source["project_id"],
                            report_type="sales_report",
                            country=country,
                            report_date=target_date,
                            period_start_date=target_date,
                            period_end_date=target_date,
                            snapshot_at=None,
                            version=next_version,
                            is_current=False,
                            superseded_at=None,
                            upload_file_id=source["upload_file_id"],
                            upload_file_path=source["upload_file_path"],
                            original_filename=source["original_filename"],
                            stored_filename=source["stored_filename"],
                            logical_filename=logical_filename,
                            storage_key=storage_key,
                            file_size_bytes=source["file_size_bytes"],
                            file_sha256=source["file_sha256"],
                            ingestion_status=source["ingestion_status"] or "success",
                            ingestion_error=source["ingestion_error"],
                            row_count_total=0,
                            row_count_included=0,
                            created_by=source["created_by"],
                            created_at=now,
                            updated_at=now,
                        )
                        .returning(sources.c.id)
                    )
                    target_source_id = int(insert_result.scalar_one())

            if target_source_id == int(source["id"]):
                kept_source_as_target = True

            row_ids = sorted(by_date[target_date])
            existing_max_row_no = int(
                bind.execute(
                    sa.select(sa.func.coalesce(sa.func.max(sales_rows.c.source_row_no), 0))
                    .where(sales_rows.c.source_file_id == target_source_id)
                ).scalar_one()
                or 0
            )
            for index, row_id in enumerate(row_ids, start=1):
                bind.execute(
                    sa.update(sales_rows)
                    .where(sales_rows.c.id == row_id)
                    .values(
                        source_file_id=target_source_id,
                        source_row_no=existing_max_row_no + index,
                    )
                )

            stats = bind.execute(
                sa.select(
                    sa.func.count(sales_rows.c.id),
                    sa.func.coalesce(
                        sa.func.sum(
                            sa.case(
                                (sales_rows.c.is_counted_sales.is_(True), 1),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                ).where(sales_rows.c.source_file_id == target_source_id)
            ).one()
            bind.execute(
                sa.update(sources)
                .where(
                    sources.c.project_id == source["project_id"],
                    sources.c.report_type == "sales_report",
                    sources.c.country == country,
                    sources.c.period_start_date == target_date,
                    sources.c.period_end_date == target_date,
                    sources.c.id != target_source_id,
                    sources.c.is_current.is_(True),
                )
                .values(is_current=False, superseded_at=now)
            )
            bind.execute(
                sa.update(sources)
                .where(sources.c.id == target_source_id)
                .values(
                    report_date=target_date,
                    period_start_date=target_date,
                    period_end_date=target_date,
                    row_count_total=int(stats[0] or 0),
                    row_count_included=int(stats[1] or 0),
                    ingestion_status="success",
                    ingestion_error=None,
                    is_current=True,
                    superseded_at=None,
                )
            )
            updated_sources += 1

        if not kept_source_as_target:
            bind.execute(
                sa.update(sources)
                .where(sources.c.id == source["id"])
                .values(
                    is_current=False,
                    superseded_at=now,
                )
            )

    print(
        "[alembic] fixed non-US sales timezone dates: "
        f"rows={fixed_rows}, sources_updated={updated_sources}, sources_split={split_sources}"
    )


def downgrade() -> None:
    pass
