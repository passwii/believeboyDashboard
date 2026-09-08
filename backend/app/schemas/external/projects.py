"""Project response schemas for the shared agent project query."""
from __future__ import annotations

from pydantic import BaseModel, Field


class AgentShopItem(BaseModel):
    shop_id: str
    country: str
    site: str


class ProjectItem(BaseModel):
    """Minimal project descriptor returned by the agent projects list."""

    project_id: int
    project_name: str
    country: str = "US"
    country_name: str | None = None
    is_active: bool = True
    shops: list[AgentShopItem] = Field(default_factory=list)
