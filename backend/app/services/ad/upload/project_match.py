from __future__ import annotations

import pandas as pd
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project
from app.schemas.ad_upload import AdUploadProjectMatchSummary
from app.services.data.sku_info import match_projects_by_identifiers
import app.services.project_service as project_service
from app.services.ad.upload.specs import ReportSpec
from app.services.ad.upload.utils import _normalize_identifier


def _build_project_match(
    db: Session,
    *,
    df: pd.DataFrame,
    spec: ReportSpec,
    country: str,
    allowed_projects: set[str] | None = None,
) -> AdUploadProjectMatchSummary:
    if not spec.project_match_fields:
        return AdUploadProjectMatchSummary(
            status='manual',
            message='该报表需要手动选择项目',
        )

    for match_by, column_name in spec.project_match_fields:
        # Case-insensitive column lookup (Amazon exports sometimes use mixed case)
        actual_column = next(
            (c for c in df.columns if str(c).lower() == column_name.lower()),
            None,
        )
        if actual_column is None:
            continue
        values = sorted(
            {
                _normalize_identifier(value)
                for value in df[actual_column].dropna().tolist()
                if _normalize_identifier(value)
            }
        )
        if not values:
            continue

        matched_map = match_projects_by_identifiers(
            db,
            identifiers=values,
            match_by=match_by,
            country=country,
        )
        if allowed_projects is not None:
            matched_map = {
                key: [project for project in projects if project in allowed_projects]
                for key, projects in matched_map.items()
            }

        all_projects = sorted(
            {project for projects in matched_map.values() for project in projects}
        )
        matched_values = [key for key, projects in matched_map.items() if projects]

        if len(all_projects) == 1:
            return AdUploadProjectMatchSummary(
                status='matched',
                project_name=all_projects[0],
                candidate_projects=all_projects,
                matched_by=match_by,
                matched_values=matched_values[:8],
                message=f'已根据{match_by.upper()}自动匹配项目',
            )
        if len(all_projects) > 1:
            return AdUploadProjectMatchSummary(
                status='conflict',
                candidate_projects=all_projects,
                matched_by=match_by,
                matched_values=matched_values[:8],
                message=f'检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）',
            )

    return AdUploadProjectMatchSummary(
        status='manual',
        message='未匹配到唯一项目，请手动选择',
    )


def _resolve_project(
    db: Session,
    *,
    project_name: str,
    operator: str | None,
    is_admin: bool,
) -> Project:
    normalized = (project_name or '').strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='project_name is required',
        )

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }
    if normalized not in allowed_projects:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='当前账号无权操作该项目',
        )

    project = (
        db.execute(select(Project).where(Project.project_name == normalized))
        .scalars()
        .first()
    )
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail='project not found',
        )
    return project
