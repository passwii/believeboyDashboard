from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.models import AnalysisPT1Calculation
from app.schemas.product_analysis_source import (
    AnalysisSourceFileItem,
    AnalysisSourceRowsResponse,
    CurrentInventorySnapshotResponse,
)
from app.services import product_analysis_source_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/product-analysis/sources', response_model=list[AnalysisSourceFileItem])
def list_product_analysis_sources(
    project_id: int | None = Query(default=None, gt=0),
    report_type: Literal['business_report', 'payment_report', 'ad_report', 'sales_report', 'inventory_report']
    | None = Query(default=None),
    period_start_date: date | None = Query(default=None),
    period_end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> list[AnalysisSourceFileItem]:
    effective_current_only = False if include_history else current_only
    rows = product_analysis_source_service.list_sources(
        db,
        project_id=project_id,
        report_type=report_type,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        current_only=effective_current_only,
    )
    return [_to_source_item(row) for row in rows]


@router.get('/product-analysis/sources/{source_id:int}/rows', response_model=AnalysisSourceRowsResponse)
def get_product_analysis_source_rows(
    source_id: int,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=1000),
    include_excluded: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> AnalysisSourceRowsResponse:
    try:
        source, rows, has_next = product_analysis_source_service.get_source_rows(
            db,
            source_id=source_id,
            page=page,
            page_size=page_size,
            include_excluded=include_excluded,
        )
    except ValueError as exc:
        if str(exc) == 'Source file not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return AnalysisSourceRowsResponse(
        source=_to_source_item(source),
        page=page,
        page_size=page_size,
        has_next=has_next,
        rows=rows,
    )


@router.get('/product-analysis/inventory/current', response_model=CurrentInventorySnapshotResponse)
def get_current_inventory_snapshot(
    project_id: int = Query(gt=0),
    db: Session = Depends(get_db_session),
) -> CurrentInventorySnapshotResponse:
    payload = product_analysis_source_service.get_current_inventory_snapshot(db, project_id=project_id)
    if payload is None:
        raise HTTPException(status_code=404, detail='Current inventory snapshot not found')
    source, rows = payload
    return CurrentInventorySnapshotResponse(source=_to_source_item(source), rows=rows)


@router.get('/product-analysis/pt1')
def list_product_analysis_pt1(
    project_id: int | None = Query(default=None, gt=0),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    db: Session = Depends(get_db_session),
):
    stmt = db.query(AnalysisPT1Calculation).order_by(
        AnalysisPT1Calculation.report_start_date.desc(),
        AnalysisPT1Calculation.id.desc()
    )
    if current_only:
        stmt = stmt.where(AnalysisPT1Calculation.is_current.is_(True))
    if project_id is not None:
        stmt = stmt.where(AnalysisPT1Calculation.project_id == project_id)
    if start_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_start_date <= end_date)
    rows = stmt.all()
    
    return [
        {
            'id': row.id,
            'project_id': row.project_id,
            'project_name': row.project_name,
            'report_start_date': row.report_start_date,
            'report_end_date': row.report_end_date,
            'version': row.version,
            'is_current': row.is_current,
            'row_count': row.row_count,
            'summary_row': row.summary_row,
            'result_file_path': row.result_file_path,
            'calculation_version': row.calculation_version,
            'computed_at': row.computed_at,
            'created_at': row.created_at,
        }
        for row in rows
    ]


@router.get('/product-analysis/weekly')
def list_product_analysis_weekly(
    project_id: int = Query(gt=0),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    db: Session = Depends(get_db_session),
):
    rows = product_analysis_source_service.list_weekly_product_analysis_from_details(
        db,
        project_id=project_id,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )
    if rows:
        return rows

    stmt = db.query(AnalysisPT1Calculation).where(AnalysisPT1Calculation.project_id == project_id).order_by(
        AnalysisPT1Calculation.report_start_date.desc(),
        AnalysisPT1Calculation.id.desc(),
    )
    if current_only:
        stmt = stmt.where(AnalysisPT1Calculation.is_current.is_(True))
    if start_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_start_date <= end_date)

    fallback_rows = stmt.all()
    return [
        {
            'id': row.id,
            'project_id': row.project_id,
            'project_name': row.project_name,
            'report_start_date': row.report_start_date,
            'report_end_date': row.report_end_date,
            'version': row.version,
            'is_current': row.is_current,
            'row_count': row.row_count,
            'total_sales': float((row.summary_row or {}).get('实际销售额', (row.summary_row or {}).get('总销售额', 0)) or 0),
            'total_units': int((row.summary_row or {}).get('实际销售量', (row.summary_row or {}).get('总销量', 0)) or 0),
            'total_ad_spend': float((row.summary_row or {}).get('广告花费', 0) or 0),
        }
        for row in fallback_rows
    ]


def _to_source_item(row) -> AnalysisSourceFileItem:
    return AnalysisSourceFileItem(
        id=row.id,
        project_id=row.project_id,
        report_type=row.report_type,
        period_start_date=row.period_start_date,
        period_end_date=row.period_end_date,
        snapshot_at=row.snapshot_at,
        version=row.version,
        is_current=row.is_current,
        superseded_at=row.superseded_at,
        upload_file_id=row.upload_file_id,
        upload_file_path=row.upload_file_path,
        original_filename=row.original_filename,
        stored_filename=row.stored_filename,
        logical_filename=row.logical_filename,
        storage_key=row.storage_key,
        file_size_bytes=row.file_size_bytes,
        file_sha256=row.file_sha256,
        ingestion_status=row.ingestion_status,
        ingestion_error=row.ingestion_error,
        row_count_total=row.row_count_total,
        row_count_included=row.row_count_included,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
