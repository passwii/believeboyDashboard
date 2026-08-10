"""Project-related response schemas for the shared read-query layer.

原 external 命名空间的共享 schema（external 机制已退役删除，BLF-583），供 agent 原生域复用。"""
from __future__ import annotations

from pydantic import BaseModel


class ProjectItem(BaseModel):
    """Minimal project descriptor returned by ``GET /external/projects``.

    Only ``project_id`` and ``project_name`` are exposed. Country / status /
    timestamps live in the project resource and can be fetched via the
    internal ``/projects`` endpoint when needed.
    """

    project_id: int
    project_name: str