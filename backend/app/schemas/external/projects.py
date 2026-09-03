"""Project-related response schemas for the shared read-query layer.

原 external 命名空间的共享 schema（external 机制已退役删除，BLF-583），供 agent 原生域复用。"""
from __future__ import annotations

from pydantic import BaseModel


class ProjectItem(BaseModel):
    """Minimal project descriptor returned by the agent projects list.

    ``country`` is the canonical country code; ``country_name`` is the
    Chinese site label rendered for agents.
    """

    project_id: int
    project_name: str
    country: str = "US"
    country_name: str | None = None
