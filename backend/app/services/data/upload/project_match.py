from __future__ import annotations

from sqlalchemy.orm import Session

from app.schemas.upload import ReportProjectMatchSummary
from app.services.data.sku_info import match_projects_by_identifiers
from app.utils.recognition import _normalize_identifier


def _build_project_match(
    db: Session,
    *,
    values: list[str],
    match_by: str,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> ReportProjectMatchSummary:
    normalized_values = sorted(
        {
            _normalize_identifier(value)
            for value in values
            if _normalize_identifier(value)
        }
    )
    if not normalized_values:
        return ReportProjectMatchSummary(
            status="unmatched",
            matched_by=match_by,
            message="文件中未找到可用于匹配项目的标识",
        )

    matched_map = match_projects_by_identifiers(
        db,
        identifiers=normalized_values,
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
        message = f"已根据{match_by.upper()}自动匹配项目"
        if len(matched_values) != len(normalized_values):
            message = f"已根据部分{match_by.upper()}自动匹配项目"
        return ReportProjectMatchSummary(
            status="matched",
            project_name=all_projects[0],
            candidate_projects=all_projects,
            matched_by=match_by,
            matched_values=matched_values[:8],
            message=message,
        )

    if len(all_projects) > 1:
        return ReportProjectMatchSummary(
            status="conflict",
            candidate_projects=all_projects,
            matched_by=match_by,
            matched_values=matched_values[:8],
            message=f"检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）",
        )

    return ReportProjectMatchSummary(
        status="unmatched",
        matched_by=match_by,
        matched_values=[],
        message="未匹配到项目，请手动选择",
    )
