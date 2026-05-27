"""Shared helpers for fetching and formatting project/SKU context for AI prompts.

Used by both daily and weekly report builders to enrich AI analysis with
project background, SKU special status, and factory product attributes.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.sku_info import SkuRecord

logger = logging.getLogger(__name__)

# Known top-level keys in a single-project project_context dict
_PROJECT_CONTEXT_KEYS = frozenset(
    {"factory", "productSeasonality", "productGrowth", "projectStatus", "notes"}
)


def fetch_multi_project_context(
    db: Session,
    project_ids: list[int] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Fetch and merge project_context / sku_context for one or more projects.

    Returns (project_context, sku_context) where:
    - Single project: raw dicts from the Project model (or None)
    - Multiple projects: project_context keyed by project_name, sku_context merged
    """
    if project_ids is not None and len(project_ids) == 0:
        return None, None

    # Resolve project list
    if project_ids is None:
        rows = (
            db.execute(
                select(Project)
                .where(Project.is_active == True)  # noqa: E712
                .order_by(Project.id)
                .limit(10)
            )
            .scalars()
            .all()
        )
    else:
        rows = (
            db.execute(
                select(Project).where(Project.id.in_(project_ids))
            )
            .scalars()
            .all()
        )

    if not rows:
        return None, None

    # Single project — return raw dicts (compatible with existing formatting helpers)
    if len(rows) == 1:
        row = rows[0]
        return row.project_context, row.sku_context

    # Multiple projects — merge
    merged_project_ctx: dict[str, Any] = {}
    merged_sku_ctx: dict[str, Any] = {}

    for row in rows:
        try:
            pc = row.project_context
            sc = row.sku_context

            if pc:
                merged_project_ctx[row.project_name] = pc
            if sc:
                for sku_key, sku_val in sc.items():
                    if sku_key in merged_sku_ctx:
                        # Prefix with project name to avoid collision
                        merged_sku_ctx[f"{row.project_name}/{sku_key}"] = sku_val
                    else:
                        merged_sku_ctx[sku_key] = sku_val
        except Exception:
            logger.warning("Failed to fetch context for project %s", row.id, exc_info=True)
            continue

    return merged_project_ctx or None, merged_sku_ctx or None


def _is_single_project_context(ctx: dict[str, Any] | None) -> bool:
    """Check whether ctx is a single-project context dict (vs multi-project keyed by name)."""
    if not ctx:
        return True
    return bool(_PROJECT_CONTEXT_KEYS & ctx.keys())


def format_project_context_for_prompt(
    project_context: dict[str, Any] | None,
) -> str:
    """Format project_context into prompt text. Handles both single and multi-project."""
    from app.services.ai_insight_generator import _format_project_context_for_prompt

    if not project_context:
        return _format_project_context_for_prompt({})

    if _is_single_project_context(project_context):
        return _format_project_context_for_prompt(project_context)

    # Multi-project: render each with a project name header
    parts = []
    for name, ctx in project_context.items():
        text = _format_project_context_for_prompt(ctx)
        parts.append(f"### {name}\n{text}")
    return "\n\n".join(parts)


def format_sku_context_for_prompt(
    sku_context: dict[str, Any] | None,
) -> str:
    """Format sku_context into prompt text."""
    from app.services.ai_insight_generator import _format_sku_context_for_prompt

    return _format_sku_context_for_prompt(sku_context or {})


def fetch_and_format_sku_factory_info(
    db: Session,
    sku_names: list[str],
    country: str,
    project_ids: list[int] | None,
) -> str:
    """Fetch factory info for specific SKUs and format for AI prompt.

    Only queries the given SKU names (not all SKUs) to control token budget.
    """
    if not sku_names:
        return "（暂无产品属性信息）"

    try:
        query = select(SkuRecord).where(
            SkuRecord.sku.in_(sku_names),
            SkuRecord.country == country,
            SkuRecord.is_active == True,  # noqa: E712
            SkuRecord.sku_factory_info.isnot(None),
        )
        if project_ids:
            query = query.where(SkuRecord.project_id.in_(project_ids))

        rows = db.execute(query).scalars().all()

        if not rows:
            return "（暂无产品属性信息）"

        lines = []
        for row in rows:
            info = row.sku_factory_info
            if not info or not isinstance(info, dict):
                continue
            attrs = ", ".join(f"{k}={v}" for k, v in info.items() if v)
            if attrs:
                name_part = f" ({row.product_name})" if row.product_name else ""
                lines.append(f"- **{row.sku}**{name_part}: {attrs}")

        return "\n".join(lines) if lines else "（暂无产品属性信息）"

    except Exception:
        logger.warning("Failed to fetch SKU factory info", exc_info=True)
        return "（暂无产品属性信息）"
