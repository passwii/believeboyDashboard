"""Project-related response schemas for the external API."""
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