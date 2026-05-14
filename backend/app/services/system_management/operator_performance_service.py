"""
运营绩效服务。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.operator_performance_record import OperatorPerformanceRecord


def upsert_operator_performance(
    db: Session,
    items: list[dict],
    operator: str | None = None,
) -> tuple[str, list[OperatorPerformanceRecord]]:
    """Upsert 运营绩效记录。Returns (last_report_month, records)."""
    touched_months: set[str] = set()
    for item in items:
        month = item.report_month
        touched_months.add(month)
        person_name = item.person_name.strip()
        role_type = item.role_type.strip()
        project_name = item.project_name.strip()

        row = None
        if item.id is not None:
            row = db.execute(
                select(OperatorPerformanceRecord).where(OperatorPerformanceRecord.id == item.id)
            ).scalars().first()
        if row is None:
            row = db.execute(
                select(OperatorPerformanceRecord).where(
                    OperatorPerformanceRecord.report_month == month,
                    OperatorPerformanceRecord.week_index == item.week_index,
                    OperatorPerformanceRecord.project_id == item.project_id,
                    OperatorPerformanceRecord.person_name == person_name,
                    OperatorPerformanceRecord.role_type == role_type,
                )
            ).scalars().first()
        if row is None:
            row = OperatorPerformanceRecord(
                report_month=month,
                week_index=item.week_index,
                project_id=item.project_id,
                project_name=project_name,
                person_name=person_name,
                role_type=role_type,
                score=item.score,
                note=(item.note or "").strip() or None,
                updated_by=operator,
            )
            db.add(row)
        else:
            row.report_month = month
            row.week_index = item.week_index
            row.project_id = item.project_id
            row.project_name = project_name
            row.person_name = person_name
            row.role_type = role_type
            row.score = item.score
            row.note = (item.note or "").strip() or None
            row.updated_by = operator

    db.commit()

    target_month = sorted(touched_months)[-1] if touched_months else ""
    if not target_month:
        return "", []

    rows = db.execute(
        select(OperatorPerformanceRecord).where(
            OperatorPerformanceRecord.report_month == target_month
        ).order_by(
            OperatorPerformanceRecord.person_name.asc(),
            OperatorPerformanceRecord.project_name.asc(),
            OperatorPerformanceRecord.week_index.asc(),
        )
    ).scalars().all()

    return target_month, rows